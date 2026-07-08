// importCommissioniAssistenza.mjs
// Importatore CSV "Commissioni" (pagina Commissioni di Vamart, filtro
// "Commissioni Assistenza" = "Solo di assistenza") -> Supabase.
//
// Diverso da importVamartCsv.mjs: quel modulo legge il CSV "Piano di carico"
// (dettaglio articoli/ordini). Questo legge invece l'elenco sintetico delle
// commissioni di assistenza (una riga per commissione, non per articolo) e
// serve a intercettare le pratiche aperte direttamente su Vamart dal
// personale, che non passano dal flusso app/email del cliente e altrimenti
// non entrerebbero mai nel sistema di monitoraggio.
//
// Comportamento:
//  - riconosce pratiche gia' esistenti tramite codice_commissione (stessa
//    chiave naturale usata da importVamartCsv.mjs) e le lascia invariate:
//    lo stato di lavorazione resta di competenza del flusso principale
//  - per le commissioni NON ancora presenti, crea cliente (se mancante) e
//    una pratica "grezza" con stato iniziale 'aperta', cosi' compare nel
//    monitoraggio anche se non e' mai arrivata l'email del cliente
//  - registra la sessione in importazioni_csv (origine: scraper_automatico)
//    e gli errori riga per riga in importazioni_csv_errori
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

// Mappa flessibile: normalizza intestazioni del CSV (case/spazi) su chiavi interne.
// Se Vamart cambia leggermente il testo delle colonne, va aggiornata qui.
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
    riga._numeroRiga = indice + 2; // +1 per header, +1 perche' 1-based
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

  let nuove = 0, giaPresenti = 0, errori = 0;

  for (const riga of righe) {
    try {
      if (!riga.idCommissione || !riga.idCommissione.trim()) {
        throw new Error("Riga senza 'Id commissione', scartata");
      }
      const codiceCommissione = riga.idCommissione.trim();

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

      const { data: clienteEsistente } = await supabase
        .from("clienti")
        .select("id")
        .eq("nome_completo", nomeCompleto)
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

      const dettagliParti = ["Commissione di assistenza importata da Vamart (non presente nel flusso app/email)."];
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
        data_apertura: parseDataItaliana(riga.dataRegistrazione) || new Date().toISOString(),
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
      righe_aggiornate: 0,
      righe_invariate: giaPresenti,
      righe_errore: errori,
      stato: errori > 0 ? "completata_con_errori" : "completata",
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  console.log(`Import completata. Pratiche nuove: ${nuove}, gia' presenti: ${giaPresenti}, errori: ${errori}`);
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exit(1);
});
