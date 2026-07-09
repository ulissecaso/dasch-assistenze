// lib/monitor/caricaDatiDirezione.ts
// Query condivisa dai due punti che mostrano il Monitor Assistenze "vista
// ufficio": la Dashboard Direzione autenticata (/dashboard-direzione) e il
// link pubblico di sola visualizzazione per il monitor a parete
// (/monitor/direzione). Accetta un client Supabase già pronto (con sessione
// utente o service role, indifferentemente) così la logica di calcolo resta
// un'unica fonte di verità.
import type { AlertRigaMonitor, OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, coloreOperatore, formattaScadenza, costruisciMappaRegole, calcolaLivelloDaRitardo, etichettaArrivoMerce } from "@/lib/monitor/mappature";

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function caricaDatiDirezione(supabase: any) {
  const adesso = new Date().toISOString();
  const adessoMs = Date.now();

  const [{ data: faseRitardoConteggio }, { data: faseRitardoTabella }, { data: operatoriAttivi }, { count: praticheTotali }, { count: risoltiOggi }, { data: regoleAttive }] = await Promise.all([
    // Query "conteggio": alimenta le card per operatore e le statistiche
    // (scaduti, in scadenza oggi, urgenti...). Volutamente SENZA il limite
    // usato per la tabella: se la limitassimo, un operatore con tante fasi
    // vecchie in ritardo "ruberebbe" spazio ad altri e i conteggi per
    // operatore risulterebbero troncati e sbagliati (visti anche solo 71 su
    // 241 reali per un operatore). Selezioniamo solo i campi indispensabili
    // per il conteggio, per tenere leggera una query senza limite di righe.
    supabase
      .from("pratica_fasi")
      .select(`
        id, data_prevista, fase_id,
        pratiche(id, stato_generale, operatore_assegnato_id)
      `)
      .in("stato", ["da_iniziare", "in_corso"])
      .lt("data_prevista", adesso)
      .limit(5000),
    // Query "tabella": righe da mostrare nel Monitor Assistenze, ordinate
    // dalla più urgente (più vecchia) in su. Questo limite serve solo a
    // contenere il payload della tabella: la vista a parete la taglia
    // ulteriormente a righeMax (11) tramite MonitorBoard.
    supabase
      .from("pratica_fasi")
      .select(`
        id, stato, data_prevista, fase_id,
        fasi_workflow(codice, nome),
        pratiche(id, codice_commissione, stato_generale, operatore_assegnato_id,
          clienti(nome_completo),
          utenti:operatore_assegnato_id(id, nome, cognome, colore_badge)
        )
      `)
      .in("stato", ["da_iniziare", "in_corso"])
      .lt("data_prevista", adesso)
      .order("data_prevista", { ascending: true })
      .limit(300),
    supabase.from("utenti").select("id, nome, cognome, colore_badge").eq("ruolo", "operatore").eq("attivo", true).order("nome"),
    supabase.from("pratiche").select("*", { count: "exact", head: true }).not("stato_generale", "in", '("chiusa","annullata")'),
    supabase.from("pratiche").select("*", { count: "exact", head: true }).eq("stato_generale", "chiusa").gte("data_chiusura_effettiva", `${oggiIso()}T00:00:00Z`),
    supabase.from("regole_alert").select("fase_id, soglia_valore, soglia_unita, livello").eq("attiva", true),
  ]);

  const regolePerFase = costruisciMappaRegole(regoleAttive);

  // Le pratiche già chiuse/annullate non contano come "in ritardo" anche se
  // una loro fase è rimasta con data_prevista scaduta: filtro qui perché
  // PostgREST non permette di filtrare comodamente su una colonna della
  // relazione embedded direttamente nella query.
  const conLivello = (righe: any[] | null | undefined) =>
    (righe ?? [])
      .filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale))
      .map((r: any) => {
        const oreRitardo = (adessoMs - new Date(r.data_prevista).getTime()) / 3_600_000;
        return { ...r, livello: calcolaLivelloDaRitardo(regolePerFase, r.fase_id, oreRitardo) };
      });

  // Usata per conteggi/statistiche: SENZA il limite della tabella.
  const righeConLivelloConteggio = conLivello(faseRitardoConteggio);
  // Usata solo per le righe mostrate nella tabella del monitor.
  const righeConLivelloTabella = conLivello(faseRitardoTabella);

  // Percentuale di merce arrivata in deposito, solo per le pratiche che
  // compaiono in tabella con la fase "arrivo_merce" ancora aperta: serve
  // per mostrare "Merce parzialmente pronta in deposito (NN%)" invece del
  // generico "in ritardo" quando ha gia' superato la soglia (vedi
  // etichettaArrivoMerce in mappature.ts).
  const idPraticheArrivoMerce = righeConLivelloTabella
    .filter((r: any) => r.fasi_workflow?.codice === "arrivo_merce")
    .map((r: any) => r.pratiche.id);
  const mappaPercentualeMerce = new Map<string, number>();
  if (idPraticheArrivoMerce.length > 0) {
    const { data: percentuali } = await supabase
      .from("v_percentuale_merce_arrivata")
      .select("pratica_id, percentuale_arrivata")
      .in("pratica_id", idPraticheArrivoMerce);
    for (const p of percentuali ?? []) mappaPercentualeMerce.set(p.pratica_id, p.percentuale_arrivata);
  }

  const oggi = oggiIso();
  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;
  const righeOrdinate = [...righeConLivelloTabella].sort((a: any, b: any) => {
    const rangoA = RANGO_LIVELLO[a.livello as keyof typeof RANGO_LIVELLO];
    const rangoB = RANGO_LIVELLO[b.livello as keyof typeof RANGO_LIVELLO];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return a.data_prevista.localeCompare(b.data_prevista);
  });
  const alertRows: AlertRigaMonitor[] = righeOrdinate.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    const { data, ora } = formattaScadenza(r.data_prevista);
    const opNome = p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato";
    const opColore = p.utenti ? coloreOperatore(p.utenti.id, p.utenti.colore_badge) : "#6b7280";
    const etichettaParziale = fw?.codice === "arrivo_merce" ? etichettaArrivoMerce(mappaPercentualeMerce.get(p.id)) : null;
    return {
      id: r.id,
      livello: r.livello,
      scadenzaData: data,
      scadenzaOra: ora,
      praticaCodice: p.codice_commissione,
      cliente: p.clienti?.nome_completo ?? "—",
      faseNome: fw?.nome ?? "Fase",
      faseIcona: ICONA_PER_FASE[fw?.codice] ?? "warn-sm",
      descrizione: etichettaParziale ?? `${fw?.nome ?? "Fase"} in ritardo`,
      operatoreNome: opNome,
      operatoreColore: opColore,
      azione: AZIONE_PER_FASE[fw?.codice] ?? "Verificare fase",
    };
  });

  // Le card per operatore e le statistiche usano SEMPRE il set completo
  // (righeConLivelloConteggio), mai quello troncato della tabella.
  const operatori: OperatoreCardMonitor[] = (operatoriAttivi ?? []).map((op: any) => {
    const righeOp = righeConLivelloConteggio.filter((r: any) => r.pratiche.operatore_assegnato_id === op.id);
    return {
      id: op.id,
      nome: `${op.nome} ${op.cognome}`,
      colore: coloreOperatore(op.id, op.colore_badge),
      alertAttivi: righeOp.length,
      urgenti: righeOp.filter((r: any) => r.livello === "critica").length,
    };
  });

  const scaduti = righeConLivelloConteggio.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righeConLivelloConteggio.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

  return {
    alertRows,
    operatori,
    stats: {
      allertTotali: righeConLivelloConteggio.length,
      allertUrgenti: righeConLivelloConteggio.filter((r) => r.livello === "critica").length,
      scaduti,
      inScadenzaOggi,
      risoltiOggi: risoltiOggi ?? 0,
      praticheTotali: praticheTotali ?? 0,
    },
  };
}
