// lib/import/parseCsvTesto.ts
// Variante "da testo" (anziché da percorso file) della logica di parsing
// usata da scripts/import-csv/parseCsv.mjs, per l'uso nella Route Handler
// di Next.js (che riceve il CSV come contenuto via upload, non come path).
//
// NOTA IMPORTANTE: questa è la stessa logica del CLI in scripts/import-csv.
// In produzione va estratta in un package condiviso (es. packages/import-logic)
// per evitare la duplicazione tra CLI e API route. Duplicata qui solo per
// mantenere questo scaffold auto-contenuto e facilmente leggibile.
import { parse } from "csv-parse/sync";
import { createHash } from "node:crypto";

const HEADER_MAP: Record<string, string> = {
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

export function parseNumeroItaliano(valore: string): number {
  if (!valore || valore.trim() === "") return 0;
  const pulito = valore.trim().replace(/\./g, "").replace(",", ".");
  const n = Number(pulito);
  return Number.isFinite(n) ? n : 0;
}

export function parseDataItaliana(valore: string): string | null {
  if (!valore || valore.trim() === "") return null;
  const m = valore.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const [, gg, mm, aaaa] = m;
  return `${aaaa}-${mm.padStart(2, "0")}-${gg.padStart(2, "0")}`;
}

function calcolaRigaHash(riga: Record<string, unknown>): string {
  const chiave = [
    riga.fornitore, riga.codice_articolo, riga.descrizione, riga.quantita_venduta,
    riga.listino, riga.quantita_ordinata, riga.data_ordine, riga.conferma_ordine,
    riga.rif_conferma, riga.pag_azienda, riga.data_consegna_prevista, riga.quantita_giacente,
    riga.data_carico, riga.quantita_consegnata, riga.data_consegna, riga.status,
    riga.magazzino, riga.ubicazione,
  ].join("|");
  return createHash("sha256").update(chiave).digest("hex");
}

export function parseFileCompletoDaTesto(testoCsv: string) {
  const grezze: Record<string, string>[] = parse(testoCsv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  const righe: any[] = [];
  const errori: { numero_riga: number; messaggio: string; dato_grezzo: unknown }[] = [];

  grezze.forEach((rigaGrezza, idx) => {
    const numeroRiga = idx + 2;
    const r: Record<string, string> = {};
    for (const [headerOriginale, campoInterno] of Object.entries(HEADER_MAP)) {
      r[campoInterno] = rigaGrezza[headerOriginale] ?? "";
    }

    const codiceCommissione = (r.codice_commissione || "").trim();
    const clienteTrim = (r.cliente || "").trim();
    const problemi: string[] = [];
    if (!codiceCommissione) problemi.push("Codice commissione mancante");
    if (!clienteTrim) problemi.push("Cliente mancante");

    if (problemi.length > 0 && !codiceCommissione) {
      errori.push({ numero_riga: numeroRiga, messaggio: problemi.join("; "), dato_grezzo: rigaGrezza });
      return;
    }

    const normalizzata: any = {
      numero_riga: numeroRiga,
      cliente: clienteTrim || `Cliente da verificare (commissione ${codiceCommissione || "sconosciuta"})`,
      fornitore: (r.fornitore || "").trim(),
      codice_articolo: (r.codice_articolo || "").trim() || null,
      categoria: (r.categoria || "").trim() || null,
      descrizione: (r.descrizione || "").trim(),
      data_consegna_cliente: parseDataItaliana(r.data_consegna_cliente),
      quantita_venduta: parseNumeroItaliano(r.quantita_venduta),
      listino: parseNumeroItaliano(r.listino),
      codice_commissione: codiceCommissione,
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
    normalizzata.riga_hash = calcolaRigaHash(normalizzata);
    righe.push(normalizzata);

    if (problemi.length > 0) {
      errori.push({ numero_riga: numeroRiga, messaggio: problemi.join("; "), dato_grezzo: rigaGrezza });
    }
  });

  return { righe, errori };
}
