// parseCsv.mjs
// Parsing e normalizzazione del CSV "Piano di carico" esportato dal gestionale.
// Colonne reali osservate nel file di esempio (Vamart):
// Cliente, Fornitore, Codice articolo, Categoria, Descrizione, Data consegna cliente,
// Quantita venduta, Listino, Codice commissione, Data commissione, Quantita ordinata,
// Data ordine, Conferma ordine, Rif. conferma, Pag.Azienda, Data Consegna Prevista,
// Quantita giacente, Data carico, Quantita consegnata, Data consegna, Status, Magazzino, Ubicazione

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";

const HEADER_MAP = {
  "Cliente": "cliente",
  "Fornitore": "fornitore",
  "Codice articolo": "codice_articolo",
  "Categoria": "categoria",
  "Descrizione": "descrizione",
  "Data consegna cliente": "data_consegna_cliente",
  "Quantità venduta": "quantita_venduta",
  "Listino": "listino",
  "Codice commissione": "codice_commissione",
  "Data commissione": "data_commissione",
  "Quantità ordinata": "quantita_ordinata",
  "Data ordine": "data_ordine",
  "Conferma ordine": "conferma_ordine",
  "Rif. conferma": "rif_conferma",
  "Pag.Azienda": "pag_azienda",
  "Data Consegna Prevista": "data_consegna_prevista",
  "Quantità giacente": "quantita_giacente",
  "Data carico": "data_carico",
  "Quantità consegnata": "quantita_consegnata",
  "Data consegna": "data_consegna",
  "Status": "status",
  "Magazzino": "magazzino",
  "Ubicazione": "ubicazione",
};

/** "1.234,56" | "0,00" | "" -> number */
export function parseNumeroItaliano(valore) {
  if (!valore || typeof valore !== "string" || valore.trim() === "") return 0;
  const pulito = valore.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(pulito);
  return Number.isFinite(n) ? n : 0;
}

/** "06/07/2026" -> "2026-07-06" (ISO). Ritorna null se vuoto/non valido. */
export function parseDataItaliana(valore) {
  if (!valore || typeof valore !== "string" || valore.trim() === "") return null;
  const m = valore.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, gg, mm, aaaa] = m;
  return `${aaaa}-${mm.padStart(2, "0")}-${gg.padStart(2, "0")}`;
}

const STATUS_VALIDI = new Set([
  "Da ordinare",
  "Ordinato",
  "In giacenza",
  "Parzialmente consegnato",
  "Consegnato",
]);

/**
 * Legge il file CSV grezzo e ritorna un array di righe normalizzate.
 * Gestisce campi multilinea tra virgolette (es. descrizioni con "a capo").
 */
export function leggiCsvGrezzo(percorsoFile) {
  const contenuto = readFileSync(percorsoFile, "utf8");
  const record = parse(contenuto, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  return record;
}

/**
 * Normalizza una riga CSV grezza (chiavi = header originali) in un oggetto
 * con campi tipizzati pronti per il mapping sul database.
 */
export function normalizzaRiga(rigaGrezza, numeroRiga) {
  const errori = [];
  const r = {};
  for (const [headerOriginale, campoInterno] of Object.entries(HEADER_MAP)) {
    r[campoInterno] = rigaGrezza[headerOriginale] ?? "";
  }

  if (!r.codice_commissione || r.codice_commissione.trim() === "") {
    errori.push("Codice commissione mancante: impossibile associare la riga a una pratica");
  }
  if (!r.cliente || r.cliente.trim() === "") {
    errori.push("Cliente mancante");
  }
  if (r.status && !STATUS_VALIDI.has(r.status.trim())) {
    errori.push(`Status non riconosciuto: "${r.status}"`);
  }

  const codiceCommissioneTrim = (r.codice_commissione || "").trim();
  const clienteTrim = (r.cliente || "").trim();

  const normalizzata = {
    numero_riga: numeroRiga,
    // se il cliente manca nel CSV (dato mancante nel gestionale), usiamo un placeholder
    // tracciabile invece di creare un cliente "vuoto": l'errore resta comunque loggato
    // in importazioni_csv_errori per la verifica manuale in admin.
    cliente: clienteTrim || `Cliente da verificare (commissione ${codiceCommissioneTrim || "sconosciuta"})`,
    fornitore: (r.fornitore || "").trim(),
    codice_articolo: (r.codice_articolo || "").trim() || null,
    categoria: (r.categoria || "").trim() || null,
    descrizione: (r.descrizione || "").trim(),
    data_consegna_cliente: parseDataItaliana(r.data_consegna_cliente),
    quantita_venduta: parseNumeroItaliano(r.quantita_venduta),
    listino: parseNumeroItaliano(r.listino),
    codice_commissione: codiceCommissioneTrim,
    data_commissione: parseDataItaliana(r.data_commissione),
    quantita_ordinata: parseNumeroItaliano(r.quantita_ordinata),
    data_ordine: parseDataItaliana(r.data_ordine),
    conferma_ordine: (r.conferma_ordine || "").trim() || null,
    rif_conferma: (r.rif_conferma || "").trim() || null,
    pag_azienda: (r.pag_azienda || "").trim() || null,
    data_consegna_prevista: parseDataItaliana(r.data_consegna_prevista),
    quantita_giacente: parseNumeroItaliano(r.quantita_giacente),
    data_carico: parseDataItaliana(r.data_carico),
    quantita_consegnata: parseNumeroItaliano(r.quantita_consegnata),
    data_consegna: parseDataItaliana(r.data_consegna),
    status: (r.status || "").trim() || null,
    magazzino: (r.magazzino || "").trim() || null,
    ubicazione: (r.ubicazione || "").trim() || null,
  };

  return { normalizzata, errori };
}

/** Hash stabile dei campi "di dettaglio" di una riga, per rilevare modifiche in importazioni successive. */
export function calcolaRigaHash(riga) {
  const chiave = [
    riga.fornitore,
    riga.codice_articolo,
    riga.descrizione,
    riga.quantita_venduta,
    riga.listino,
    riga.quantita_ordinata,
    riga.data_ordine,
    riga.conferma_ordine,
    riga.rif_conferma,
    riga.pag_azienda,
    riga.data_consegna_prevista,
    riga.quantita_giacente,
    riga.data_carico,
    riga.quantita_consegnata,
    riga.data_consegna,
    riga.status,
    riga.magazzino,
    riga.ubicazione,
  ].join("|");
  return createHash("sha256").update(chiave).digest("hex");
}

/**
 * Legge e normalizza l'intero file, ritornando { righe, errori } dove
 * ogni elemento di errori contiene { numero_riga, messaggio, dato_grezzo }.
 */
export function parseFileCompleto(percorsoFile) {
  const grezze = leggiCsvGrezzo(percorsoFile);
  const righe = [];
  const errori = [];

  grezze.forEach((rigaGrezza, idx) => {
    const numeroRiga = idx + 2;
    const { normalizzata, errori: erroriRiga } = normalizzaRiga(rigaGrezza, numeroRiga);
    if (erroriRiga.length > 0 && !normalizzata.codice_commissione) {
      errori.push({ numero_riga: numeroRiga, messaggio: erroriRiga.join("; "), dato_grezzo: rigaGrezza });
      return;
    }
    normalizzata.riga_hash = calcolaRigaHash(normalizzata);
    righe.push(normalizzata);
    if (erroriRiga.length > 0) {
      errori.push({ numero_riga: numeroRiga, messaggio: erroriRiga.join("; "), dato_grezzo: rigaGrezza });
    }
  });

  return { righe, errori };
}
