// lib/monitor/caricaDatiDirezione.ts
// Query condivisa dai due punti che mostrano il Monitor Assistenze "vista
// ufficio": la Dashboard Direzione autenticata (/dashboard-direzione) e il
// link pubblico di sola visualizzazione per il monitor a parete
// (/monitor/direzione). Accetta un client Supabase già pronto (con sessione
// utente o service role, indifferentemente) così la logica di calcolo resta
// un'unica fonte di verità.
import type { AlertRigaMonitor, OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, coloreOperatore, formattaScadenza } from "@/lib/monitor/mappature";

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

// La priorità mostrata a monitor NON usa più la colonna statica
// `pratiche.priorita` (che restava quasi sempre "normale" e non rifletteva
// mai il vero ritardo accumulato). Viene invece calcolata al volo per ogni
// fase in ritardo confrontando le ore di ritardo con le soglie configurate
// in `regole_alert` per quella specifica fase (le stesse soglie usate per le
// notifiche/escalation, cosi' la dashboard e gli alert restano coerenti).
type RegolaSoglia = { sogliaOre: number; livello: string };

function calcolaLivelloDaRitardo(
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

export async function caricaDatiDirezione(supabase: any) {
  const adesso = new Date().toISOString();
  const adessoMs = Date.now();

  const [{ data: faseRitardo }, { data: operatoriAttivi }, { count: praticheTotali }, { count: risoltiOggi }, { data: regoleAttive }] = await Promise.all([
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

  const regolePerFase = new Map<string, RegolaSoglia[]>();
  for (const r of regoleAttive ?? []) {
    if (!r.fase_id) continue;
    const sogliaOre = r.soglia_unita === "giorni" ? r.soglia_valore * 24 : r.soglia_valore;
    const lista = regolePerFase.get(r.fase_id) ?? [];
    lista.push({ sogliaOre, livello: r.livello });
    regolePerFase.set(r.fase_id, lista);
  }

  // Le pratiche già chiuse/annullate non contano come "in ritardo" anche se
  // una loro fase è rimasta con data_prevista scaduta: filtro qui perché
  // PostgREST non permette di filtrare comodamente su una colonna della
  // relazione embedded direttamente nella query.
  const righeConLivello = (faseRitardo ?? [])
    .filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale))
    .map((r: any) => {
      const oreRitardo = (adessoMs - new Date(r.data_prevista).getTime()) / 3_600_000;
      return { ...r, livello: calcolaLivelloDaRitardo(regolePerFase, r.fase_id, oreRitardo) };
    });

  const oggi = oggiIso();
  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;
  const righeOrdinate = [...righeConLivello].sort((a: any, b: any) => {
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
    return {
      id: r.id,
      livello: r.livello,
      scadenzaData: data,
      scadenzaOra: ora,
      praticaCodice: p.codice_commissione,
      cliente: p.clienti?.nome_completo ?? "—",
      faseNome: fw?.nome ?? "Fase",
      faseIcona: ICONA_PER_FASE[fw?.codice] ?? "warn-sm",
      descrizione: `${fw?.nome ?? "Fase"} in ritardo`,
      operatoreNome: opNome,
      operatoreColore: opColore,
      azione: AZIONE_PER_FASE[fw?.codice] ?? "Verificare fase",
    };
  });

  const operatori: OperatoreCardMonitor[] = (operatoriAttivi ?? []).map((op: any) => {
    const righeOp = righeConLivello.filter((r: any) => r.pratiche.operatore_assegnato_id === op.id);
    return {
      id: op.id,
      nome: `${op.nome} ${op.cognome}`,
      colore: coloreOperatore(op.id, op.colore_badge),
      alertAttivi: righeOp.length,
      urgenti: righeOp.filter((r: any) => r.livello === "critica").length,
    };
  });

  const scaduti = righeConLivello.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righeConLivello.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

  return {
    alertRows,
    operatori,
    stats: {
      allertTotali: alertRows.length,
      allertUrgenti: alertRows.filter((r) => r.livello === "critica").length,
      scaduti,
      inScadenzaOggi,
      risoltiOggi: risoltiOggi ?? 0,
      praticheTotali: praticheTotali ?? 0,
    },
  };
}
