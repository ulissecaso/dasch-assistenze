// importVamartCsv.mjs
// Importatore CSV "Piano di carico" -> Supabase (pratiche / pratica_righe / clienti / fornitori)
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importVamartCsv.mjs "/percorso/Piano di carico.csv"
//
// Comportamento:
//  - riconosce pratiche esistenti tramite codice_commissione (chiave naturale del gestionale)
//  - crea clienti/fornitori mancanti
//  - crea pratiche nuove, aggiorna quelle esistenti solo se cambia lo stato_generale derivato
//  - per ogni riga: crea la riga se nuova, aggiorna solo i campi cambiati (via riga_hash) e
//    scrive un evento in storico_modifiche
//  - registra la sessione di importazione in importazioni_csv (+ errori riga per riga)
//  - fa avanzare automaticamente le fasi "Invio ordine ricambi", "Arrivo merce in
//    deposito" e "Consegna materiale" guardando lo stato aggregato delle righe
//    della pratica (Status: Da ordinare / Ordinato / In giacenza /
//    Parzialmente consegnato / Consegnato) -- vedi sincronizzaFasiDaRighe.
//    Il cronometro di ogni fase riparte da solo grazie al trigger DB
//    trg_pratica_fasi_avvia_cronometro (migrazione 0009).
//
// Questo modulo e' pensato per essere lanciato manualmente, da uno scheduler (cron) o
// invocato dallo scraper automatico (vedi /scraper) subito dopo il download del file.

import { createClient } from "@supabase/supabase-js";
import { parseFileCompleto } from "./parseCsv.mjs";
import { raggruppaInPratiche } from "./mapToDomain.mjs";

// Se l'ambiente di esecuzione richiede un proxy HTTP/HTTPS (es. reti aziendali
// o ambienti sandbox), lo configuriamo qui per il fetch globale di Node.
// In produzione (Vercel, server senza proxy) queste variabili non sono
// impostate e questo blocco non ha alcun effetto.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function main() {
  const percorsoFile = process.argv[2];
  if (!percorsoFile) {
    console.error("Uso: node importVamartCsv.mjs <percorso-file-csv>");
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Impostare le variabili d'ambiente SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Fasi che questo importatore fa avanzare in base allo stato delle righe.
  // Risolte per codice (non id fisso), cosi' restano valide anche se
  // qualcuno le ricrea dal pannello admin.
  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", ["ordine_ricambi", "arrivo_merce", "consegna_materiale"]);
  if (erroreFasi) throw erroreFasi;
  const fasiIds = {
    ordine_ricambi: fasiWorkflow.find((f) => f.codice === "ordine_ricambi")?.id,
    arrivo_merce: fasiWorkflow.find((f) => f.codice === "arrivo_merce")?.id,
    consegna_materiale: fasiWorkflow.find((f) => f.codice === "consegna_materiale")?.id,
  };
  if (!fasiIds.ordine_ricambi || !fasiIds.arrivo_merce || !fasiIds.consegna_materiale) {
    throw new Error("Fasi 'ordine_ricambi', 'arrivo_merce' e/o 'consegna_materiale' non trovate in fasi_workflow");
  }

  console.log(`Lettura file: ${percorsoFile}`);
  const { righe, errori: erroriParsing } = parseFileCompleto(percorsoFile);
  const pratiche = raggruppaInPratiche(righe);

  console.log(`Righe totali valide: ${righe.length}, pratiche distinte: ${pratiche.length}, errori parsing: ${erroriParsing.length}`);

  // 1. registra sessione di importazione
  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: percorsoFile.split("/").pop(),
      origine: "manuale",
      righe_totali: righe.length,
      stato: "in_corso",
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  let nuove = 0, aggiornate = 0, invariate = 0, righeErrore = 0;

  for (const pratica of pratiche) {
    try {
      // upsert cliente (match per nome_completo)
      const { data: clienteEsistente } = await supabase
        .from("clienti")
        .select("id")
        .eq("nome_completo", pratica.cliente)
        .maybeSingle();

      let clienteId = clienteEsistente?.id;
      if (!clienteId) {
        const { data: nuovoCliente, error } = await supabase
          .from("clienti")
          .insert({ nome_completo: pratica.cliente })
          .select()
          .single();
        if (error) throw error;
        clienteId = nuovoCliente.id;
      }

      // upsert pratica (match per codice_commissione)
      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("*")
        .eq("codice_commissione", pratica.codice_commissione)
        .maybeSingle();

      let praticaId;
      if (!praticaEsistente) {
        const { data: nuovaPratica, error } = await supabase
          .from("pratiche")
          .insert({
            codice_commissione: pratica.codice_commissione,
            cliente_id: clienteId,
            tipo: pratica.tipo,
            categoria: pratica.categoria,
            canale_origine: "csv",
            fonte_dati: "csv",
            stato_generale: pratica.stato_generale,
            data_consegna_prevista: pratica.data_consegna_cliente,
          })
          .select()
          .single();
        if (error) throw error;
        praticaId = nuovaPratica.id;
        nuove++;
      } else {
        praticaId = praticaEsistente.id;
        if (praticaEsistente.stato_generale !== pratica.stato_generale) {
          await supabase
            .from("pratiche")
            .update({ stato_generale: pratica.stato_generale })
            .eq("id", praticaId);
          await supabase.from("storico_modifiche").insert({
            entita: "pratica",
            entita_id: praticaId,
            campo: "stato_generale",
            valore_precedente: praticaEsistente.stato_generale,
            valore_nuovo: pratica.stato_generale,
            origine: "importazione_csv",
          });
          aggiornate++;
        } else {
          invariate++;
        }
      }

      // upsert righe della pratica
      for (const riga of pratica.righe) {
        let fornitoreId = null;
        if (riga.fornitore) {
          const { data: fornitoreEsistente } = await supabase
            .from("fornitori")
            .select("id")
            .eq("ragione_sociale", riga.fornitore)
            .maybeSingle();
          fornitoreId = fornitoreEsistente?.id;
          if (!fornitoreId) {
            const { data: nuovoFornitore, error } = await supabase
              .from("fornitori")
              .insert({ ragione_sociale: riga.fornitore })
              .select()
              .single();
            if (error) throw error;
            fornitoreId = nuovoFornitore.id;
          }
        }

        const { data: rigaEsistente } = await supabase
          .from("pratica_righe")
          .select("id, riga_hash, status_riga")
          .eq("pratica_id", praticaId)
          .eq("codice_articolo", riga.codice_articolo)
          .eq("descrizione", riga.descrizione)
          .maybeSingle();

        const payloadRiga = {
          pratica_id: praticaId,
          fornitore_id: fornitoreId,
          codice_articolo: riga.codice_articolo,
          descrizione: riga.descrizione,
          quantita_venduta: riga.quantita_venduta,
          listino: riga.listino,
          quantita_ordinata: riga.quantita_ordinata,
          data_ordine: riga.data_ordine,
          conferma_ordine: riga.conferma_ordine,
          rif_conferma: riga.rif_conferma,
          pag_azienda: riga.pag_azienda,
          data_consegna_prevista: riga.data_consegna_prevista,
          quantita_giacente: riga.quantita_giacente,
          data_carico: riga.data_carico,
          quantita_consegnata: riga.quantita_consegnata,
          data_consegna: riga.data_consegna,
          status_riga: riga.status,
          magazzino: riga.magazzino,
          ubicazione: riga.ubicazione,
          riga_hash: riga.riga_hash,
        };

        if (!rigaEsistente) {
          const { error } = await supabase.from("pratica_righe").insert(payloadRiga);
          if (error) throw error;
        } else if (rigaEsistente.riga_hash !== riga.riga_hash) {
          const { error } = await supabase
            .from("pratica_righe")
            .update(payloadRiga)
            .eq("id", rigaEsistente.id);
          if (error) throw error;
          await supabase.from("storico_modifiche").insert({
            entita: "pratica_riga",
            entita_id: rigaEsistente.id,
            campo: "status_riga",
            valore_precedente: rigaEsistente.status_riga,
            valore_nuovo: riga.status,
            origine: "importazione_csv",
          });
        }
      }

      await sincronizzaFasiDaRighe(supabase, praticaId, pratica.righe, fasiIds);
    } catch (err) {
      righeErrore++;
      await supabase.from("importazioni_csv_errori").insert({
        importazione_id: importazione.id,
        messaggio_errore: String(err.message || err),
        dato_grezzo: pratica,
      });
    }
  }

  // registra eventuali errori di parsing (righe scartate prima ancora del mapping)
  for (const e of erroriParsing) {
    await supabase.from("importazioni_csv_errori").insert({
      importazione_id: importazione.id,
      numero_riga: e.numero_riga,
      messaggio_errore: e.messaggio,
      dato_grezzo: e.dato_grezzo,
    });
  }

  await supabase
    .from("importazioni_csv")
    .update({
      righe_nuove: nuove,
      righe_aggiornate: aggiornate,
      righe_invariate: invariate,
      righe_errore: righeErrore + erroriParsing.length,
      stato: righeErrore + erroriParsing.length > 0 ? "completata_con_errori" : "completata",
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  console.log(`Import completata. Pratiche nuove: ${nuove}, aggiornate: ${aggiornate}, invariate: ${invariate}, errori: ${righeErrore + erroriParsing.length}`);
}

// ---------------------------------------------------------------------
// Fa avanzare "Invio ordine ricambi" / "Arrivo merce in deposito" /
// "Consegna materiale" in base allo stato aggregato delle righe della
// pratica. Ogni fase si completa solo quando TUTTE le righe hanno
// raggiunto (almeno) lo stato corrispondente -- se anche una sola riga e'
// rimasta indietro, la fase resta aperta e il motore di alert la segnala
// secondo le soglie configurate dal pannello admin.
// Le condizioni sono indipendenti (non solo sequenziali): se un import
// arriva con le righe gia' tutte "Consegnato" senza essere mai passate da
// noi per gli step intermedi, completa comunque anche le fasi precedenti.
// ---------------------------------------------------------------------
const STATI_ORDINATO_O_OLTRE = new Set(["Ordinato", "In giacenza", "Parzialmente consegnato", "Consegnato"]);
const STATI_ARRIVATO_O_OLTRE = new Set(["In giacenza", "Parzialmente consegnato", "Consegnato"]);

async function sincronizzaFasiDaRighe(supabase, praticaId, righe, fasiIds) {
  if (!righe || righe.length === 0) return;

  const tutteOrdinate = righe.every((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  const tutteConsegnate = righe.every((r) => r.status === "Consegnato");

  const { data: fasiAttuali } = await supabase
    .from("pratica_fasi")
    .select("id, fase_id, stato")
    .eq("pratica_id", praticaId)
    .in("fase_id", [fasiIds.ordine_ricambi, fasiIds.arrivo_merce, fasiIds.consegna_materiale]);

  const perFase = Object.fromEntries((fasiAttuali ?? []).map((f) => [f.fase_id, f]));

  const passaggi = [
    { faseId: fasiIds.ordine_ricambi, condizione: tutteOrdinate, nota: "Tutte le righe risultano ordinate su Vamart (Piano di Carico)." },
    { faseId: fasiIds.arrivo_merce, condizione: tutteArrivate, nota: "Tutte le righe risultano arrivate in giacenza su Vamart (Piano di Carico)." },
    { faseId: fasiIds.consegna_materiale, condizione: tutteConsegnate, nota: "Tutte le righe risultano consegnate su Vamart (Piano di Carico)." },
  ];

  for (const [indice, passaggio] of passaggi.entries()) {
    const faseCorrente = perFase[passaggio.faseId];
    if (!faseCorrente || faseCorrente.stato === "completata" || !passaggio.condizione) continue;

    await supabase
      .from("pratica_fasi")
      .update({ stato: "completata", data_effettiva: new Date().toISOString(), note: passaggio.nota })
      .eq("id", faseCorrente.id);

    const prossimoPassaggio = passaggi[indice + 1];
    if (prossimoPassaggio) {
      const faseSuccessiva = perFase[prossimoPassaggio.faseId];
      if (faseSuccessiva && faseSuccessiva.stato === "da_iniziare") {
        await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseSuccessiva.id);
      }
    }
  }
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exit(1);
});
