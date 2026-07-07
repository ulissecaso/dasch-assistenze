// lib/import/mapToDomain.ts — vedi scripts/import-csv/mapToDomain.mjs (stessa logica, versione TS)
export function calcolaStatoGenerale(righe: { status: string | null }[]): string {
  const statusSet = new Set(righe.map((r) => r.status).filter(Boolean));
  if (statusSet.size === 0) return "aperta";
  if (statusSet.size === 1 && statusSet.has("Consegnato")) return "chiusa";
  if (statusSet.size === 1 && statusSet.has("Da ordinare")) return "aperta";
  return "in_lavorazione";
}

export function raggruppaInPratiche(righeNormalizzate: any[]) {
  const mappa = new Map<string, any>();
  for (const riga of righeNormalizzate) {
    const chiave = riga.codice_commissione;
    if (!mappa.has(chiave)) {
      mappa.set(chiave, {
        codice_commissione: chiave,
        cliente: riga.cliente,
        categoria: riga.categoria,
        data_commissione: riga.data_commissione,
        data_consegna_cliente: riga.data_consegna_cliente,
        righe: [],
      });
    }
    mappa.get(chiave).righe.push(riga);
  }
  const pratiche = [];
  for (const pratica of mappa.values()) {
    pratica.stato_generale = calcolaStatoGenerale(pratica.righe);
    pratica.tipo = pratica.categoria;
    pratiche.push(pratica);
  }
  return pratiche;
}
