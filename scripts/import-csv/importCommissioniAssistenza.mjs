// importCommissioniAssistenza.mjs
// Importatore CSV "Commissioni" (pagina Commissioni di Vamart, filtro
// "Commissioni Assistenza" = "Solo di assistenza") -> Supabase.
//
// Le commissioni di assistenza su Vamart nascono in due modi diversi, e
// questo script li gestisce entrambi:
//
//  1) Il cliente segnala un problema via app/sito -> arriva la mail -> il
//     sistema crea gia' una pratica "in attesa" (fase 'creazione_commissione'
//     non ancora completata). Quando l'operatore va su Vamart e crea li' la
//     commissione di assistenza vera, Vamart le assegna un NUMERO NUOVO,
//     diverso da quello che il cliente aveva citato nella mail: non possiamo
//     quindi riconoscerla per codice_commissione. La colleghiamo per nome
//     cliente + vicinanza di data alla pratica "in attesa" corrispondente, e
//     chiudiamo automaticamente la fase (cosi' il countdown SLA si ferma).
//     Se l'operatore NON la crea in tempo, la fase resta aperta e il motore
//     di alert gia' esistente (soglie 24h/48h/escalation) segnala il ritardo.
//
//  2) Il venditore crea direttamente una commissione di assistenza su Vamart,
//     senza che sia mai arrivata una mail dal cliente. In questo caso non
//     esiste nessuna pratica "in attesa" da collegare: ne creiamo una nuova
//     "grezza" (come faceva gia' la versione precedente di questo script),
//     cosi' l'operatore la vede e deve comunque prenderla in carico.
//
// Se per lo stesso cliente risultano PIU' pratiche in attesa nella stessa
// finestra di date (caso ambiguo), non indoviniamo: la riga viene segnalata
// come errore in importazioni_csv_errori per una verifica manuale.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importCommissioniAssistenza.mjs "/percorso/commissioni.csv"

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { parseDataItaliana } from "./parseCsv.mjs";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Finestra di tolleranza per collegare una commissione Vamart a una pratica
// "in attesa": la data di apertura della pratica deve cadere entro questi
// giorni PRIMA o DOPO la data di registrazione su Vamart. Copre normali
// ritardi operativi senza rischiare di agganciare casi troppo vecchi.
const FINESTRA_GIORNI_MATCH = 20;

const ALIAS_COLONNE = {
  "id commissione": "idCommissione",
  "id preventivo": "idPreventivo",
  "cognome": "cognome",
  "nome": "nome",
  "data registrazione": "dataRegistrazione",
  "data consegna": "dataConsegna",
  "importo": "importo",
  "venditore": "venditore",
  "città": "citta",
  "citta": "citta",
};

function normalizzaIntestazione(testo) {
  return String(testo || "").trim().toLowerCase();
}

function leggiCsv(percorsoFile) {
  const contenuto = readFileSync(percorsoFile, "utf8");
  const righeGrezze = parse(contenuto, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return righeGrezze.map((rigaGrezza, indice) => {
    const riga = {};
    for (const [intestazione, valore] of Object.entries(rigaGrezza)) {
      const chiave = ALIAS_COLONNE[normalizzaIntestazione(intestazione)];
      if (chiave) riga[chiave] = valore;
    }
    riga._numeroRiga = indice + 2;
    riga._grezzo = rigaGrezza;
    return riga;
  });
}

async function main() {
  const percorsoFile = process.argv[2];
  if (!percorsoFile) {
    console.error("Uso: node importCommissioniAssistenza.mjs <percorso-file-csv>");
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Impostare le variabili d'ambiente SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Fasi del workflow che questo script deve toccare: risolte per codice,
  // non per id fisso, cosi' restano valide anche se qualcuno le ricrea.
  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", ["creazione_commissione", "ordine_ricambi"]);
  if (erroreFasi) throw erroreFasi;
  const faseCreazioneCommissioneId = fasiWorkflow.find((f) => f.codice === "creazione_commissione")?.id;
  const faseOrdineRicambiId = fasiWorkflow.find((f) => f.codice === "ordine_ricambi")?.id;
  if (!faseCreazioneCommissioneId || !faseOrdineRicambiId) {
    throw new Error("Fasi 'creazione_commissione' e/o 'ordine_ricambi' non trovate in fasi_workflow");
  }

  console.log(`Lettura file: ${percorsoFile}`);
  const righe = leggiCsv(percorsoFile);
  console.log(`Righe lette: ${righe.length}`);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: percorsoFile.split("/").pop(),
      origine: "scraper_automatico",
      righe_totali: righe.length,
      stato: "in_corso",
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  let nuove = 0, ricollegate = 0, giaPresenti = 0, errori = 0;

  for (const riga of righe) {
    try {
      if (!riga.idCommissione || !riga.idCommissione.trim()) {
        throw new Error("Riga senza 'Id commissione', scartata");
      }
      const codiceCommissione = riga.idCommissione.trim();

      // Gia' tracciata (da un import precedente, con questo stesso numero)?
      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("id")
        .eq("codice_commissione", codiceCommissione)
        .maybeSingle();

      if (praticaEsistente) {
        giaPresenti++;
        continue;
      }

      const nomeCompleto = [riga.nome, riga.cognome].filter(Boolean).join(" ").trim() || "Cliente sconosciuto";
      const dataRegistrazione = parseDataItaliana(riga.dataRegistrazione);

      // Cerca una pratica "in attesa" dello stesso cliente (nata da mail,
      // fase 'creazione_commissione' non ancora completata) aperta in una
      // finestra di date ragionevole intorno a questa registrazione Vamart.
      const { data: clientiOmonimi } = await supabase
        .from("clienti")
        .select("id")
        .ilike("nome_completo", nomeCompleto);

      let candidati = [];
      if (clientiOmonimi && clientiOmonimi.length > 0) {
        const idsClienti = clientiOmonimi.map((c) => c.id);
        const { data: pratichePendenti } = await supabase
          .from("pratiche")
          .select("id, data_apertura, pratica_fasi!inner(id, stato, fase_id)")
          .in("cliente_id", idsClienti)
          .not("stato_generale", "in", "(chiusa,annullata)")
          .eq("pratica_fasi.fase_id", faseCreazioneCommissioneId)
          .neq("pratica_fasi.stato", "completata");

        candidati = (pratichePendenti ?? []).filter((p) => {
          if (!dataRegistrazione || !p.data_apertura) return true;
          const giorni = Math.abs((new Date(dataRegistrazione) - new Date(p.data_apertura)) / 86400000);
          return giorni <= FINESTRA_GIORNI_MATCH;
        });
      }

      if (candidati.length === 1) {
        const pratica = candidati[0];
        const faseCreazione = pratica.pratica_fasi[0];

        await supabase
          .from("pratica_fasi")
          .update({
            stato: "completata",
            data_effettiva: new Date().toISOString(),
            note: `Commissione di assistenza creata su Vamart: ${codiceCommissione} (rilevata dal controllo automatico giornaliero).`,
          })
          .eq("id", faseCreazione.id);

        await supabase
          .from("pratica_fasi")
          .update({ stato: "in_corso" })
          .eq("pratica_id", pratica.id)
          .eq("fase_id", faseOrdineRicambiId)
          .eq("stato", "da_iniziare");

        await supabase.from("storico_modifiche").insert({
          entita: "pratiche",
          entita_id: pratica.id,
          campo: "creazione_commissione",
          valore_precedente: null,
          valore_nuovo: codiceCommissione,
          origine: "scraper_automatico",
        });

        ricollegate++;
        continue;
      }

      if (candidati.length > 1) {
        throw new Error(
          `Trovate ${candidati.length} pratiche in attesa per "${nomeCompleto}" nella stessa finestra di date: collegamento ambiguo, servono verifica manuale.`
        );
      }

      const { data: clienteEsistente } = await supabase
        .from("clienti")
        .select("id")
        .ilike("nome_completo", nomeCompleto)
        .maybeSingle();

      let clienteId = clienteEsistente?.id;
      if (!clienteId) {
        const { data: nuovoCliente, error } = await supabase
          .from("clienti")
          .insert({ nome_completo: nomeCompleto, citta: riga.citta || null })
          .select()
          .single();
        if (error) throw error;
        clienteId = nuovoCliente.id;
      }

      const dettagliParti = ["Commissione di assistenza aperta direttamente su Vamart (nessuna segnalazione via mail collegabile)."];
      if (riga.idPreventivo) dettagliParti.push(`Preventivo: ${riga.idPreventivo}.`);
      if (riga.venditore) dettagliParti.push(`Venditore: ${riga.venditore}.`);
      if (riga.importo) dettagliParti.push(`Importo: ${riga.importo}.`);

      const { error: erroreInserimento } = await supabase.from("pratiche").insert({
        codice_commissione: codiceCommissione,
        codice_commissione_riferimento: codiceCommissione,
        cliente_id: clienteId,
        tipo: "assistenza",
        canale_origine: "manuale",
        fonte_dati: "csv",
        stato_generale: "aperta",
        data_apertura: dataRegistrazione || new Date().toISOString(),
        data_consegna_prevista: parseDataItaliana(riga.dataConsegna),
        descrizione: dettagliParti.join(" "),
      });
      if (erroreInserimento) throw erroreInserimento;

      nuove++;
    } catch (err) {
      errori++;
      await supabase.from("importazioni_csv_errori").insert({
        importazione_id: importazione.id,
        numero_riga: riga._numeroRiga,
        messaggio_errore: String(err.message || err),
        dato_grezzo: riga._grezzo,
      });
    }
  }

  await supabase
    .from("importazioni_csv")
    .update({
      righe_nuove: nuove,
      righe_aggiornate: ricollegate,
      righe_invariate: giaPresenti,
      righe_errore: errori,
      stato: errori > 0 ? "completata_con_errori" : "completata",
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  console.log(
    `Import completata. Pratiche nuove: ${nuove}, ricollegate a segnalazioni via mail: ${ricollegate}, gia' presenti: ${giaPresenti}, errori: ${errori}`
  );
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exit(1);
});
