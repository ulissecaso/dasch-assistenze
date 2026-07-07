// bulkImportVamartCsv.mjs
// Variante "bulk" dell'importatore, pensata per il caricamento iniziale di grandi
// storici (migliaia di righe) in un'unica esecuzione veloce: precarica in memoria
// clienti/fornitori/pratiche/righe esistenti e scrive con insert in blocco invece
// che riga per riga. Per gli aggiornamenti quotidiani (poche decine/centinaia di
// righe cambiate) resta preferibile importVamartCsv.mjs, più semplice da leggere.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node bulkImportVamartCsv.mjs "/percorso/file.csv"

import { createClient } from "@supabase/supabase-js";
import { parseFileCompleto } from "./parseCsv.mjs";
import { raggruppaInPratiche } from "./mapToDomain.mjs";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CHUNK = 500;

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Legge tutte le righe di una tabella paginando (PostgREST limita le righe per richiesta). */
async function fetchAll(supabase, table, columns) {
  const risultati = [];
  let offset = 0;
  const pageSize = 1000;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(offset, offset + pageSize - 1);
    if (error) throw error;
    risultati.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return risultati;
}

async function main() {
  const percorsoFile = process.argv[2];
  if (!percorsoFile || !SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Uso: SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node bulkImportVamartCsv.mjs <file.csv>");
    process.exit(1);
  }
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  console.log(`Lettura file: ${percorsoFile}`);
  const { righe, errori: erroriParsing } = parseFileCompleto(percorsoFile);
  const pratiche = raggruppaInPratiche(righe);
  console.log(`Righe valide: ${righe.length}, pratiche distinte: ${pratiche.length}, errori parsing: ${erroriParsing.length}`);

  const { data: importazione } = await supabase
    .from("importazioni_csv")
    .insert({ nome_file: percorsoFile.split("/").pop(), origine: "manuale", righe_totali: righe.length, stato: "in_corso" })
    .select().single();

  // ---- 1. precarico stato attuale del database ----
  console.log("Carico clienti/fornitori/pratiche/righe esistenti...");
  const [clientiEsistenti, fornitoriEsistenti, praticheEsistenti] = await Promise.all([
    fetchAll(supabase, "clienti", "id,nome_completo"),
    fetchAll(supabase, "fornitori", "id,ragione_sociale"),
    fetchAll(supabase, "pratiche", "id,codice_commissione,stato_generale"),
  ]);
  const clientiMap = new Map(clientiEsistenti.map((c) => [c.nome_completo, c.id]));
  const fornitoriMap = new Map(fornitoriEsistenti.map((f) => [f.ragione_sociale, f.id]));
  const praticheMap = new Map(praticheEsistenti.map((p) => [p.codice_commissione, p]));

  const rigaKey = (praticaId, codiceArticolo, descrizione) => `${praticaId}||${codiceArticolo}||${descrizione}`;
  const righeEsistentiRaw = await fetchAll(supabase, "pratica_righe", "id,pratica_id,codice_articolo,descrizione,riga_hash,status_riga");
  const righeMap = new Map(righeEsistentiRaw.map((r) => [rigaKey(r.pratica_id, r.codice_articolo, r.descrizione), r]));
  console.log(`In memoria: ${clientiMap.size} clienti, ${fornitoriMap.size} fornitori, ${praticheMap.size} pratiche, ${righeMap.size} righe.`);

  // ---- 2. clienti nuovi ----
  const nomiClientiNuovi = [...new Set(pratiche.map((p) => p.cliente).filter((n) => !clientiMap.has(n)))];
  for (const gruppo of chunkArray(nomiClientiNuovi, CHUNK)) {
    const { data, error } = await supabase.from("clienti").insert(gruppo.map((nome_completo) => ({ nome_completo }))).select();
    if (error) throw error;
    for (const c of data) clientiMap.set(c.nome_completo, c.id);
  }
  console.log(`Clienti nuovi creati: ${nomiClientiNuovi.length}`);

  // ---- 3. fornitori nuovi ----
  const nomiFornitoriNuovi = [...new Set(righe.map((r) => r.fornitore).filter((n) => n && !fornitoriMap.has(n)))];
  for (const gruppo of chunkArray(nomiFornitoriNuovi, CHUNK)) {
    const { data, error } = await supabase.from("fornitori").insert(gruppo.map((ragione_sociale) => ({ ragione_sociale }))).select();
    if (error) throw error;
    for (const f of data) fornitoriMap.set(f.ragione_sociale, f.id);
  }
  console.log(`Fornitori nuovi creati: ${nomiFornitoriNuovi.length}`);

  // ---- 4. pratiche nuove + aggiornamento stato di quelle esistenti ----
  const praticheNuovePayload = [];
  const praticheDaAggiornare = [];
  for (const p of pratiche) {
    const esistente = praticheMap.get(p.codice_commissione);
    if (!esistente) {
      praticheNuovePayload.push({
        codice_commissione: p.codice_commissione,
        cliente_id: clientiMap.get(p.cliente),
        tipo: p.tipo,
        categoria: p.categoria,
        canale_origine: "csv",
        fonte_dati: "csv",
        stato_generale: p.stato_generale,
        data_consegna_prevista: p.data_consegna_cliente,
      });
    } else if (esistente.stato_generale !== p.stato_generale) {
      praticheDaAggiornare.push({ id: esistente.id, statoVecchio: esistente.stato_generale, statoNuovo: p.stato_generale });
    }
  }
  let praticheNuoveCreate = 0;
  for (const gruppo of chunkArray(praticheNuovePayload, CHUNK)) {
    const { data, error } = await supabase.from("pratiche").insert(gruppo).select();
    if (error) throw error;
    for (const pr of data) praticheMap.set(pr.codice_commissione, pr);
    praticheNuoveCreate += data.length;
  }
  for (const upd of praticheDaAggiornare) {
    await supabase.from("pratiche").update({ stato_generale: upd.statoNuovo }).eq("id", upd.id);
    await supabase.from("storico_modifiche").insert({
      entita: "pratica", entita_id: upd.id, campo: "stato_generale",
      valore_precedente: upd.statoVecchio, valore_nuovo: upd.statoNuovo, origine: "importazione_csv",
    });
  }
  console.log(`Pratiche nuove: ${praticheNuoveCreate}, aggiornate: ${praticheDaAggiornare.length}`);

  // ---- 5. righe nuove + aggiornate ----
  const righeNuovePayload = [];
  const righeDaAggiornare = [];
  for (const p of pratiche) {
    const praticaRecord = praticheMap.get(p.codice_commissione);
    const praticaId = praticaRecord.id;
    for (const r of p.righe) {
      const fornitoreId = r.fornitore ? fornitoriMap.get(r.fornitore) ?? null : null;
      const chiave = rigaKey(praticaId, r.codice_articolo, r.descrizione);
      const esistente = righeMap.get(chiave);
      const payload = {
        pratica_id: praticaId, fornitore_id: fornitoreId,
        codice_articolo: r.codice_articolo, descrizione: r.descrizione,
        quantita_venduta: r.quantita_venduta, listino: r.listino, quantita_ordinata: r.quantita_ordinata,
        data_ordine: r.data_ordine, conferma_ordine: r.conferma_ordine, rif_conferma: r.rif_conferma,
        pag_azienda: r.pag_azienda, data_consegna_prevista: r.data_consegna_prevista,
        quantita_giacente: r.quantita_giacente, data_carico: r.data_carico,
        quantita_consegnata: r.quantita_consegnata, data_consegna: r.data_consegna,
        status_riga: r.status, magazzino: r.magazzino, ubicazione: r.ubicazione, riga_hash: r.riga_hash,
      };
      if (!esistente) {
        righeNuovePayload.push(payload);
      } else if (esistente.riga_hash !== r.riga_hash) {
        righeDaAggiornare.push({ id: esistente.id, payload, statoVecchio: esistente.status_riga, statoNuovo: r.status });
      }
    }
  }
  let righeNuoveCreate = 0;
  for (const gruppo of chunkArray(righeNuovePayload, CHUNK)) {
    const { error } = await supabase.from("pratica_righe").insert(gruppo);
    if (error) throw error;
    righeNuoveCreate += gruppo.length;
  }
  for (const upd of righeDaAggiornare) {
    await supabase.from("pratica_righe").update(upd.payload).eq("id", upd.id);
    await supabase.from("storico_modifiche").insert({
      entita: "pratica_riga", entita_id: upd.id, campo: "status_riga",
      valore_precedente: upd.statoVecchio, valore_nuovo: upd.statoNuovo, origine: "importazione_csv",
    });
  }
  console.log(`Righe nuove: ${righeNuoveCreate}, aggiornate: ${righeDaAggiornare.length}`);

  // ---- 6. errori di parsing ----
  for (const gruppo of chunkArray(erroriParsing, CHUNK)) {
    await supabase.from("importazioni_csv_errori").insert(
      gruppo.map((e) => ({ importazione_id: importazione.id, numero_riga: e.numero_riga, messaggio_errore: e.messaggio, dato_grezzo: e.dato_grezzo }))
    );
  }

  await supabase.from("importazioni_csv").update({
    righe_nuove: righeNuoveCreate,
    righe_aggiornate: righeDaAggiornare.length,
    righe_invariate: righe.length - righeNuoveCreate - righeDaAggiornare.length,
    righe_errore: erroriParsing.length,
    stato: erroriParsing.length > 0 ? "completata_con_errori" : "completata",
    completata_il: new Date().toISOString(),
  }).eq("id", importazione.id);

  console.log("=== IMPORT COMPLETATA ===");
  console.log(`Pratiche nuove: ${praticheNuoveCreate}, aggiornate: ${praticheDaAggiornare.length}`);
  console.log(`Righe nuove: ${righeNuoveCreate}, aggiornate: ${righeDaAggiornare.length}, errori parsing: ${erroriParsing.length}`);
}

main().catch((err) => {
  console.error("Errore fatale:", err);
  process.exit(1);
});
