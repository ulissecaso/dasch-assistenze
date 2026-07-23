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
  conferma_ordine: "check",
  arrivo_merce: "box",
  preparazione_intervento: "box",
  consegna_materiale: "truck",
  chiusura_assistenza: "check",
  // Modulo Consegne (migrazione 0010_modulo_consegne.sql).
  pianificazione_consegna: "truck",
  pagamento: "check",
};

export const AZIONE_PER_FASE: Record<string, string> = {
  ricezione_segnalazione: "Verificare segnalazione",
  presa_in_carico: "Prendere in carico",
  apertura_pratica: "Aprire pratica",
  creazione_commissione: "Creare commissione",
  ordine_ricambi: "Inviare ordine ricambi",
  conferma_ordine: "Dichiarare conferma ordine",
  arrivo_merce: "Verificare con fornitore",
  preparazione_intervento: "Preparare intervento",
  consegna_materiale: "Organizzare consegna",
  chiusura_assistenza: "Chiudere assistenza",
  // Modulo Consegne (migrazione 0010_modulo_consegne.sql).
  pianificazione_consegna: "Fissare la consegna sul Planning Vamart",
  pagamento: "Sollecitare il pagamento",
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

/** Soglia di default (%) di merce arrivata in deposito oltre la quale una
 *  pratica ancora "in ritardo" sulla fase arrivo_merce viene comunque
 *  segnalata come "parzialmente pronta" invece che genericamente "in
 *  ritardo". Valore fisso nel codice (non configurabile da pannello admin,
 *  a differenza delle soglie SLA): per cambiarlo serve un intervento di
 *  sviluppo. Il dato reale (quantita' ordinata/arrivata) viene letto dalla
 *  vista v_percentuale_merce_arrivata, alimentata dalle righe del Piano di
 *  Carico Vamart (vedi scripts/import-csv/importVamartCsv.mjs). */
export const SOGLIA_MERCE_PARZIALE = 80;

/** Restituisce l'etichetta "Merce parzialmente pronta in deposito (NN%)"
 *  quando la percentuale di merce arrivata supera la soglia ma non ha
 *  ancora raggiunto il 100% (nel qual caso la fase risulta gia' completata
 *  e non compare piu' tra gli alert). Restituisce null se non applicabile:
 *  in quel caso il chiamante usa la descrizione generica della fase. */
export function etichettaArrivoMerce(percentualeArrivata: number | null | undefined): string | null {
  if (percentualeArrivata == null) return null;
  if (percentualeArrivata >= 100) return null;
  if (percentualeArrivata >= SOGLIA_MERCE_PARZIALE) {
    return `Merce parzialmente pronta in deposito (${percentualeArrivata}%)`;
  }
  return null;
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

/** Parole che, se presenti (anche come parte di un'altra parola: "compresa in
 *  essa") nel codice commissione o nel nome cliente, escludono la pratica da
 *  tutte le viste "dash" (Dashboard Direzione/Operatore e Monitor a parete,
 *  sia Assistenza sia Consegne): sono le commesse di allestimento
 *  mostra/negozio/fiera, che non fanno parte del flusso di assistenza post
 *  vendita al cliente finale e intasavano gli alert. Il pannello admin
 *  (/admin, gestione pratiche) NON applica questo filtro: li' devono restare
 *  visibili e gestibili tutte le pratiche, comprese queste.
 *  Confronto case-insensitive e "accent-insensitive" (expo/expò contano
 *  uguali) tramite normalizzazione NFD. */
const PAROLE_ESCLUSE_DASH = ["expo", "mostra", "negozio"];

function normalizzaTesto(testo: string): string {
  return testo
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

export function contieneParolaEsclusaDaDash(testo: string | null | undefined): boolean {
  if (!testo) return false;
  const t = normalizzaTesto(testo);
  return PAROLE_ESCLUSE_DASH.some((parola) => t.includes(parola));
}

/** Vera se la pratica (codice commissione o nome cliente) va esclusa dalle
 *  viste dash: vedi commento su PAROLE_ESCLUSE_DASH sopra. */
export function praticaEspositivaDaEscludere(pratica: {
  codice_commissione?: string | null;
  clienti?: { nome_completo?: string | null } | null;
}): boolean {
  return (
    contieneParolaEsclusaDaDash(pratica.codice_commissione) ||
    contieneParolaEsclusaDaDash(pratica.clienti?.nome_completo)
  );
}
