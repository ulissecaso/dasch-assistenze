// lib/email/parserSegnalazione.ts
// Riconosce e interpreta le mail di segnalazione assistenza in arrivo su
// servizioclienti@arredamenticinquegrana.it. Oggi esistono due formati:
//
// 1) "app" — generata dall'app aziendale (testo semplice):
//      Oggetto: Segnalazione: Prodotto difettoso - Comm.340/23
//      Nome: Pinco e Pallino
//      Tipo: Prodotto difettoso
//      Commissione: 340/23
//
//      Descrizione:
//      <testo libero>
//
//      Inviato da iPhone
//
// 2) "sito" — generata dal form del sito (HTML, convertita in testo da
//    mailparser): un blocco di testo legale/garanzia seguito da campi
//    etichettati su righe separate:
//      Nome e cognome
//      <valore>
//      Numero di telefono
//      <valore>
//      Indirizzo e-mail
//      <valore>
//      Numero di commissione
//      <valore>
//      Descrizione del problema
//      <valore, anche multi-riga>
//
// Qualunque cambiamento di formato futuro va gestito aggiungendo un nuovo
// ramo "formato" qui, senza toccare chi consuma il risultato.

export type FormatoSegnalazione = "app" | "sito" | "sconosciuto";

export interface SegnalazioneEstratta {
  formato: FormatoSegnalazione;
  nome: string | null;
  telefono: string | null;
  email: string | null;
  commissione: string | null;
  tipoProblema: string | null;
  descrizione: string | null;
}

function pulisci(testo: string | null | undefined): string | null {
  if (!testo) return null;
  const v = testo.replace(/\r/g, "").trim();
  return v.length > 0 ? v : null;
}

function normalizzaCommissione(testo: string | null): string | null {
  const v = pulisci(testo);
  if (!v) return null;
  // Es. "Comm.340/23" nell'oggetto, o "340 / 23" con spazi -> normalizza a "340/23"
  return v.replace(/^comm\.?\s*/i, "").replace(/\s*\/\s*/g, "/").trim();
}

function rilevaFormato(oggetto: string, corpo: string): FormatoSegnalazione {
  if (/^\s*segnalazione\s*:/i.test(oggetto)) return "app";
  if (/nuovo invio da assistenza/i.test(oggetto)) return "sito";
  // fallback sul corpo, nel caso l'oggetto venga cambiato in futuro
  if (/^nome:/im.test(corpo) && /^commissione:/im.test(corpo)) return "app";
  if (/numero di commissione/i.test(corpo) && /descrizione del problema/i.test(corpo)) return "sito";
  return "sconosciuto";
}

function estraiFormatoApp(oggetto: string, corpo: string): SegnalazioneEstratta {
  const rigaNome = corpo.match(/^nome:\s*(.*)$/im);
  const rigaTipo = corpo.match(/^tipo:\s*(.*)$/im);
  const rigaCommissione = corpo.match(/^commissione:\s*(.*)$/im);
  const descrizioneMatch = corpo.match(/^descrizione:\s*\n([\s\S]*?)(?:\n\s*inviato da\s|\s*$)/im);

  let commissione = normalizzaCommissione(rigaCommissione?.[1] ?? null);
  if (!commissione) {
    // fallback: prova a leggerla dall'oggetto, es. "... - Comm.340/23"
    const daOggetto = oggetto.match(/comm\.?\s*([a-z0-9/\-]+)/i);
    commissione = normalizzaCommissione(daOggetto?.[1] ?? null);
  }

  return {
    formato: "app",
    nome: pulisci(rigaNome?.[1] ?? null),
    telefono: null,
    email: null,
    commissione,
    tipoProblema: pulisci(rigaTipo?.[1] ?? null),
    descrizione: pulisci(descrizioneMatch?.[1] ?? null),
  };
}

// Etichette nell'ordine in cui compaiono nella mail del sito. Servono per
// sapere dove finisce il valore di un campo (= dove inizia il successivo).
const ETICHETTE_SITO = [
  "Nome e cognome",
  "Numero di telefono",
  "Indirizzo e-mail",
  "Numero di commissione",
  "Descrizione del problema",
] as const;

function estraiCampoSito(corpo: string, etichetta: string, prossimeEtichette: string[]): string | null {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alternanza = prossimeEtichette.map(escape).join("|");
  const pattern = new RegExp(
    escape(etichetta) + "\\s*\\n+([\\s\\S]*?)(?=\\n\\s*(?:" + (alternanza || "$^") + ")\\s*\\n|$)",
    "i"
  );
  const m = corpo.match(pattern);
  return pulisci(m?.[1] ?? null);
}

function estraiFormatoSito(corpo: string): SegnalazioneEstratta {
  const valori: Record<string, string | null> = {};
  ETICHETTE_SITO.forEach((etichetta, i) => {
    const successive = ETICHETTE_SITO.slice(i + 1);
    valori[etichetta] = estraiCampoSito(corpo, etichetta, [...successive]);
  });

  return {
    formato: "sito",
    nome: valori["Nome e cognome"],
    telefono: valori["Numero di telefono"],
    email: valori["Indirizzo e-mail"],
    commissione: normalizzaCommissione(valori["Numero di commissione"]),
    tipoProblema: null,
    descrizione: valori["Descrizione del problema"],
  };
}

export function analizzaSegnalazione(oggetto: string, corpo: string): SegnalazioneEstratta {
  const formato = rilevaFormato(oggetto ?? "", corpo ?? "");
  if (formato === "app") return estraiFormatoApp(oggetto ?? "", corpo ?? "");
  if (formato === "sito") return estraiFormatoSito(corpo ?? "");
  return {
    formato: "sconosciuto",
    nome: null,
    telefono: null,
    email: null,
    commissione: null,
    tipoProblema: null,
    descrizione: null,
  };
}
