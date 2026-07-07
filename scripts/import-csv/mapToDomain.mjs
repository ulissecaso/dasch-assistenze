// mapToDomain.mjs
// Raggruppa le righe CSV normalizzate in "pratiche" (una per Codice commissione)
// con le relative righe/articoli, e calcola lo stato generale della pratica.

/**
 * Deriva lo stato_generale di una pratica dall'insieme di status delle sue righe.
 * Logica: tutte Consegnato -> chiusa; almeno una Parzialmente consegnato o mix -> in_lavorazione;
 * tutte Da ordinare -> aperta; altrimenti in_lavorazione. Il ritardo (in_ritardo) viene
 * calcolato a runtime confrontando data_consegna_prevista con la data odierna (non qui).
 */
export function calcolaStatoGenerale(righe) {
  const statusSet = new Set(righe.map((r) => r.status).filter(Boolean));
  if (statusSet.size === 0) return "aperta";
  if (statusSet.size === 1 && statusSet.has("Consegnato")) return "chiusa";
  if (statusSet.size === 1 && statusSet.has("Da ordinare")) return "aperta";
  return "in_lavorazione";
}

/**
 * Raggruppa un array di righe normalizzate (output di parseFileCompleto) in
 * un array di "pratiche": { codice_commissione, cliente, data_commissione,
 * categoria, tipo, data_consegna_prevista_pratica, stato_generale, righe: [...] }
 */
export function raggruppaInPratiche(righeNormalizzate) {
  const mappa = new Map();

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
    // tipo pratica = categoria prevalente (prima riga, come nel gestionale)
    pratica.tipo = pratica.categoria;
    pratiche.push(pratica);
  }
  return pratiche;
}

/** Estrae l'elenco univoco di clienti (per nome) presenti nel dataset. */
export function estraiClientiUnivoci(righeNormalizzate) {
  const nomi = new Set(righeNormalizzate.map((r) => r.cliente).filter(Boolean));
  return [...nomi];
}

/** Estrae l'elenco univoco di fornitori presenti nel dataset. */
export function estraiFornitoriUnivoci(righeNormalizzate) {
  const nomi = new Set(righeNormalizzate.map((r) => r.fornitore).filter(Boolean));
  return [...nomi];
}
