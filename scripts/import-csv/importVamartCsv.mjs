// importVamartCsv.mjs
// Importatore CSV "Piano di carico" -> Supabase (pratica_righe + avanzamento fasi)
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importVamartCsv.mjs "/percorso/Piano di carico.csv"
//
// IMPORTANTE: il Piano di Carico esportato da Vamart contiene TUTTE le
// commissioni (vendite normali comprese), non solo quelle di assistenza.
// Per questo motivo questo importatore NON crea mai nuove pratiche: si
// limita ad aggiornare pratiche di assistenza gia' esistenti (create dalla
// segnalazione mail oppure dall'importatore "Commissioni - Solo di
// assistenza", vedi importCommissioniAssistenza.mjs). Se una riga del Piano
// di Carico non corrisponde a nessuna pratica esistente, viene ignorata:
// significa che quella commissione non e' di assistenza.
//
// Comportamento:
//  - riconosce pratiche esistenti tramite codice_commissione (chiave naturale del gestionale)
//  - ignora le righe la cui commissione non corrisponde a nessuna pratica di assistenza esistente
//  - per ogni riga: crea la riga se nuova, aggiorna solo i campi cambiati (via riga_hash) e
//    scrive un evento in storico_modifiche
//  - registra la sessione di importazione in importazioni_csv (+ errori riga per riga)
//  - se dal Piano di Carico risulta gia' un ordine piazzato (Status: Ordinato o
//    oltre) per almeno una riga, considera "gia' avvenute" anche le fasi a monte
//    (Ricezione segnalazione / Presa in carico / Apertura pratica / Creazione
//    commissione), anche se nessuno le ha mai segnate completate su Dasch --
//    vedi completaFasiPregresse.
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
    .in("codice", ["ricezione", "presa_in_carico", "apertura_pratica", "creazione_commissione", "ordine_ricambi", "arrivo_merce", "consegna_materiale"]);
  if (erroreFasi) throw erroreFasi;
  const fasiIds = Object.fromEntries(fasiWorkflow.map((f) => [f.codice, f.id]));
  for (const codice of ["ricezione", "presa_in_carico", "apertura_pratica", "creazione_commissione", "ordine_ricambi", "arrivo_merce", "consegna_materiale"]) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow`);
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

  let nuove = 0, aggiornate = 0, invariate = 0, ignorate = 0, righeErrore = 0;

  for (const pratica of pratiche) {
    try {
      // upsert pratica (match per codice_commissione). Il Piano di Carico
      // contiene TUTTE le commissioni Vamart, comprese le vendite normali:
      // se non esiste gia' una pratica di assistenza con questo codice
      // (creata dalla segnalazione mail o dall'import "Commissioni - Solo
      // di assistenza"), questa riga non riguarda l'assistenza e va
      // ignorata, non creata.
      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("*")
        .eq("codice_commissione", pratica.codice_commissione)
        .maybeSingle();

      if (!praticaEsistente) {
        ignorate++;
        continue;
      }

      const praticaId = praticaEsistente.id;
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

      // Se dal Piano di Carico risulta gia' un ordine piazzato, le fasi a
      // monte sono evidentemente gia' avvenute anche se nessuno le ha
      // segnate su Dasch: le completiamo prima di sincronizzare il resto.
      await completaFasiPregresse(supabase, praticaId, pratica.righe, fasiIds);
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

  console.log(`Import completata. Pratiche aggiornate: ${aggiornate}, invariate: ${invariate}, ignorate (non di assistenza): ${ignorate}, errori: ${righeErrore + erroriParsing.length}`);
}

// ---------------------------------------------------------------------
// Se dal Piano di Carico risulta gia' almeno una riga con Status "Ordinato"
// o oltre, significa che l'ordine e' evidentemente gia' partito su Vamart:
// completiamo retroattivamente anche le fasi a monte (Ricezione
// segnalazione / Presa in carico / Apertura pratica / Creazione
// commissione) se non lo sono gia', anche se nessun operatore le ha mai
// segnate completate a mano su Dasch. Evita falsi allarmi "presa in carico
// in ritardo" su pratiche in realta' gia' avanzate da mesi.
// ---------------------------------------------------------------------
async function completaFasiPregresse(supabase, praticaId, righe, fasiIds) {
  const almenoUnaOrdinata = righe.some((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  if (!almenoUnaOrdinata) return;

  const { data: fasiPregresse } = await supabase
    .from("pratica_fasi")
    .select("id")
    .eq("pratica_id", praticaId)
    .in("fase_id", [fasiIds.ricezione, fasiIds.presa_in_carico, fasiIds.apertura_pratica, fasiIds.creazione_commissione])
    .neq("stato", "completata");

  if (!fasiPregresse || fasiPregresse.length === 0) return;

  await supabase
    .from("pratica_fasi")
    .update({
      stato: "completata",
      data_effettiva: new Date().toISOString(),
      note: "Completata automaticamente: risulta gia' un ordine piazzato su Vamart (Piano di Carico), la fase e' evidentemente gia' avvenuta.",
    })
    .in("id", fasiPregresse.map((f) => f.id));
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
    } else {
      // Era l'ultimo passaggio (consegna_materiale): la pratica e' di
      // fatto conclusa, non deve piu' comparire tra quelle aperte/in ritardo.
      await supabase
        .from("pratiche")
        .update({ stato_generale: "chiusa", data_chiusura_effettiva: new Date().toISOString() })
        .eq("id", praticaId)
        .not("stato_generale", "in", "(chiusa,annullata)");
    }
  }
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exit(1);
});
