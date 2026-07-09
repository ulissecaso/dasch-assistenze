// lib/monitor/mappature.ts
// Piccole mappe di presentazione condivise dalla dashboard direzione e dalla
// dashboard operatore (stesso "monitor" visivo, dati diversi). Tengono
// separata la logica di dati (server) dalla resa grafica.

export const ICONA_PER_FASE: Record<string, string> = {
  ricezione_segnalazione: "warn-sm",
  presa_in_carico: "person-sm",
  apertura_pratica: "doc",
  creazione_commissione: "doc",
  ordine_ricambi: "cart",
  arrivo_merce: "box",
  preparazione_intervento: "box",
  consegna_materiale: "truck",
  chiusura_assistenza: "check",
};

export const AZIONE_PER_FASE: Record<string, string> = {
  ricezione_segnalazione: "Verificare segnalazione",
  presa_in_carico: "Prendere in carico",
  apertura_pratica: "Aprire pratica",
  creazione_commissione: "Creare commissione",
  ordine_ricambi: "Inviare ordine ricambi",
  arrivo_merce: "Verificare con fornitore",
  preparazione_intervento: "Preparare intervento",
  consegna_materiale: "Organizzare consegna",
  chiusura_assistenza: "Chiudere assistenza",
};

/** @deprecated Non piu' usata per calcolare la priorita' mostrata a monitor:
 *  la colonna `pratiche.priorita` restava quasi sempre "normale" e non
 *  rifletteva mai il vero ritardo accumulato. Sostituita da
 *  `calcolaLivelloDaRitardo`, che confronta le ore di ritardo reali con le
 *  soglie configurate in `regole_alert`. Lasciata qui solo per eventuali usi
 *  futuri (es. priorita' impostata manualmente da un operatore). */
export function livelloMonitor(priorita: string): "critica" | "alta" | "media" | "bassa" {
  switch (priorita) {
    case "urgente": return "critica";
    case "alta": return "alta";
    case "bassa": return "bassa";
    default: return "media";
  }
}

export type RegolaSoglia = { sogliaOre: number; livello: string };

/** Costruisce, a partire dalle righe di `regole_alert` (solo quelle attive),
 *  una mappa fase_id -> elenco soglie in ore, per un lookup veloce riga per
 *  riga senza dover richiamare il database ad ogni pratica. */
export function costruisciMappaRegole(
  regoleAttive: { fase_id: string | null; soglia_valore: number; soglia_unita: string; livello: string }[] | null | undefined
): Map<string, RegolaSoglia[]> {
  const mappa = new Map<string, RegolaSoglia[]>();
  for (const r of regoleAttive ?? []) {
    if (!r.fase_id) continue;
    const sogliaOre = r.soglia_unita === "giorni" ? r.soglia_valore * 24 : r.soglia_valore;
    const lista = mappa.get(r.fase_id) ?? [];
    lista.push({ sogliaOre, livello: r.livello });
    mappa.set(r.fase_id, lista);
  }
  return mappa;
}

/** Calcola la priorita' reale di un alert confrontando le ore di ritardo
 *  della fase con le soglie configurate in `regole_alert` per quella fase
 *  (le stesse soglie usate per le notifiche/escalation, cosi' la dashboard e
 *  gli alert restano coerenti). Se non c'e' nessuna soglia superata (o nessuna
 *  regola configurata per quella fase) la priorita' resta "bassa": la fase e'
 *  comunque in ritardo, ma non ha ancora raggiunto nessun livello di allerta. */
export function calcolaLivelloDaRitardo(
  regolePerFase: Map<string, RegolaSoglia[]>,
  faseId: string,
  oreRitardo: number
): "critica" | "alta" | "media" | "bassa" {
  const regole = regolePerFase.get(faseId) ?? [];
  const soddisfatte = regole
    .filter((r) => oreRitardo >= r.sogliaOre)
    .sort((a, b) => b.sogliaOre - a.sogliaOre);
  if (soddisfatte.length === 0) return "bassa";
  switch (soddisfatte[0].livello) {
    case "escalation": return "critica";
    case "alert": return "alta";
    case "info": return "media";
    default: return "bassa";
  }
}

export const PALETTE_OPERATORI = ["#ef4444", "#f97316", "#3b82f6", "#a855f7", "#14b8a6", "#eab308"];

/** Colore stabile per operatore: usa colore_badge se impostato in admin,
 *  altrimenti ne deriva uno fisso dalla palette in base all'id (niente
 *  colori casuali che cambiano a ogni refresh). */
export function coloreOperatore(id: string, coloreBadge?: string | null): string {
  if (coloreBadge) return coloreBadge;
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return PALETTE_OPERATORI[hash % PALETTE_OPERATORI.length];
}

export function formattaScadenza(dataIso: string): { data: string; ora: string } {
  const d = new Date(dataIso);
  return {
    data: d.toLocaleDateString("it-IT"),
    ora: d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
  };
}
