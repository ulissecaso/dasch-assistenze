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

/** La tabella `pratiche.priorita` usa bassa/normale/alta/urgente; il monitor
 *  usa le etichette bassa/media/alta/critica (stesso significato, nomi diversi
 *  ereditati dal prototipo approvato). */
export function livelloMonitor(priorita: string): "critica" | "alta" | "media" | "bassa" {
  switch (priorita) {
    case "urgente": return "critica";
    case "alta": return "alta";
    case "bassa": return "bassa";
    default: return "media";
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
