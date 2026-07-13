// lib/import/parseCsvCommissioniTesto.ts
// Variante "da testo" del parsing usato da
// scripts/import-csv/importCommissioniAssistenza.mjs, per l'uso nella Route
// Handler di Next.js (upload manuale dal pannello admin). Stessa logica di
// riconoscimento colonne del CLI: vedi commento in quel file per il dettaglio
// dei due casi (commissione ricollegata a una segnalazione via mail, oppure
// aperta direttamente su Vamart).
import { parse } from "csv-parse/sync";
import { parseDataItaliana } from "./parseCsvTesto";

const ALIAS_COLONNE: Record<string, string> = {
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

function normalizzaIntestazione(testo: string): string {
  return String(testo || "").trim().toLowerCase();
}

export type RigaCommissioneGrezza = {
  idCommissione?: string;
  idPreventivo?: string;
  cognome?: string;
  nome?: string;
  dataRegistrazione?: string;
  dataConsegna?: string;
  importo?: string;
  venditore?: string;
  citta?: string;
  _numeroRiga: number;
  _grezzo: Record<string, string>;
};

export function leggiCsvCommissioniDaTesto(testoCsv: string): RigaCommissioneGrezza[] {
  const righeGrezze: Record<string, string>[] = parse(testoCsv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return righeGrezze.map((rigaGrezza, indice) => {
    const riga: any = {};
    for (const [intestazione, valore] of Object.entries(rigaGrezza)) {
      const chiave = ALIAS_COLONNE[normalizzaIntestazione(intestazione)];
      if (chiave) riga[chiave] = valore;
    }
    riga._numeroRiga = indice + 2;
    riga._grezzo = rigaGrezza;
    return riga as RigaCommissioneGrezza;
  });
}

export { parseDataItaliana };
