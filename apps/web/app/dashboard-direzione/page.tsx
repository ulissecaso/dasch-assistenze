// app/dashboard-direzione/page.tsx
// Monitor Assistenze — pensata per un grande schermo in ufficio: mostra lo
// stato di tutte le pratiche in ritardo, per operatore, sempre aggiornato.
// Il responsabile la tiene sempre a vista e interviene sugli alert persistenti.
import { creaSupabaseClientServer } from "@/lib/supabase/server";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import MonitorBoard, { type AlertRigaMonitor, type OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, livelloMonitor, coloreOperatore, formattaScadenza } from "@/lib/monitor/mappature";

export const dynamic = "force-dynamic";

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

async function caricaDatiMonitor() {
  const supabase = creaSupabaseClientServer();
  const adesso = new Date().toISOString();

  const [{ data: faseRitardo }, { data: operatoriAttivi }, { count: praticheTotali }, { count: risoltiOggi }] = await Promise.all([
    supabase
      .from("pratica_fasi")
      .select(`
        id, stato, data_prevista,
        fasi_workflow(codice, nome),
        pratiche(id, codice_commissione, priorita, stato_generale, operatore_assegnato_id,
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
  ]);

  // Le pratiche già chiuse/annullate non contano come "in ritardo" anche se
  // una loro fase è rimasta con data_prevista scaduta: filtro qui perché
  // PostgREST non permette di filtrare comodamente su una colonna della
  // relazione embedded direttamente nella query.
  const righe = (faseRitardo ?? []).filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale));

  const oggi = oggiIso();
  const alertRows: AlertRigaMonitor[] = righe.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    const { data, ora } = formattaScadenza(r.data_prevista);
    const opNome = p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato";
    const opColore = p.utenti ? coloreOperatore(p.utenti.id, p.utenti.colore_badge) : "#6b7280";
    return {
      id: r.id,
      livello: livelloMonitor(p.priorita),
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
    const righeOp = righe.filter((r: any) => r.pratiche.operatore_assegnato_id === op.id);
    return {
      id: op.id,
      nome: `${op.nome} ${op.cognome}`,
      colore: coloreOperatore(op.id, op.colore_badge),
      alertAttivi: righeOp.length,
      urgenti: righeOp.filter((r: any) => r.pratiche.priorita === "urgente").length,
    };
  });

  const scaduti = righe.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righe.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

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

export default async function DashboardDirezionePage() {
  await richiediAdmin();
  const { alertRows, operatori, stats } = await caricaDatiMonitor();

  return (
    <div className="p-4">
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />ASSISTENZE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
      />
    </div>
  );
}
