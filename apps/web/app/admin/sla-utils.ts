// app/admin/sla-utils.ts
// Funzioni pure di supporto per l'editor delle soglie SLA (nessuna direttiva
// "use server": queste vengono usate anche in fase di rendering, non solo
// come azioni di submit).

/** Converte ore totali (unità normalizzata nel DB) in {giorni, ore} per precompilare i campi del form. */
export function separaGiorniOre(soglia_valore: number | null | undefined, soglia_unita: string | null | undefined) {
  const oreTotali = soglia_unita === "giorni" ? (soglia_valore ?? 0) * 24 : (soglia_valore ?? 0);
  return { giorni: Math.floor(oreTotali / 24), ore: oreTotali % 24 };
}
