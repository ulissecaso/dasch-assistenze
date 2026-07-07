// app/dashboard-operatore/page.tsx
// Stesso "Monitor Assistenze" della dashboard direzione, ma con i dati già
// ristretti alle sole pratiche dell'operatore che ha fatto login: stessa
// resa grafica, scopo diverso (vista personale invece che vista d'ufficio).
import { richiediUtente } from "@/lib/auth/richiediUtente";
import MonitorBoard, { type AlertRigaMonitor, type OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, livelloMonitor, coloreOperatore, formattaScadenza } from "@/lib/monitor/mappature";

export const dynamic = "force-dynamic"; // pagina protetta e specifica per utente: mai cache statica/ISR

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export default async function DashboardOperatorePage() {
  const { supabase, user } = await richiediUtente();
  const adesso = new Date().toISOString();
  const oggi = oggiIso();

  const [{ data: profilo }, { data: faseRitardo }, { count: praticheTotali }, { count: risoltiOggi }] = await Promise.all([
    supabase.from("utenti").select("nome, cognome, colore_badge").eq("id", user.id).maybeSingle(),
    supabase
      .from("pratica_fasi")
      .select(`
        id, stato, data_prevista,
        fasi_workflow(codice, nome),
        pratiche!inner(id, codice_commissione, priorita, stato_generale, operatore_assegnato_id,
          clienti(nome_completo)
        )
      `)
      .in("stato", ["da_iniziare", "in_corso"])
      .lt("data_prevista", adesso)
      .eq("pratiche.operatore_assegnato_id", user.id)
      .order("data_prevista", { ascending: true })
      .limit(200),
    supabase.from("pratiche").select("*", { count: "exact", head: true }).eq("operatore_assegnato_id", user.id).not("stato_generale", "in", '("chiusa","annullata")'),
    supabase.from("pratiche").select("*", { count: "exact", head: true }).eq("operatore_assegnato_id", user.id).eq("stato_generale", "chiusa").gte("data_chiusura_effettiva", `${oggi}T00:00:00Z`),
  ]);

  const righe = (faseRitardo ?? []).filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale));

  const opColore = coloreOperatore(user.id, profilo?.colore_badge);
  const opNome = profilo ? `${profilo.nome} ${profilo.cognome}` : "Operatore";

  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;
  const righeOrdinate = [...righe].sort((a: any, b: any) => {
    const rangoA = RANGO_LIVELLO[livelloMonitor(a.pratiche.priorita)];
    const rangoB = RANGO_LIVELLO[livelloMonitor(b.pratiche.priorita)];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return a.data_prevista.localeCompare(b.data_prevista);
  });

  const alertRows: AlertRigaMonitor[] = righeOrdinate.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    const { data, ora } = formattaScadenza(r.data_prevista);
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

  const operatori: OperatoreCardMonitor[] = [{
    id: user.id,
    nome: opNome,
    colore: opColore,
    alertAttivi: alertRows.length,
    urgenti: alertRows.filter((r) => r.livello === "critica").length,
  }];

  const scaduti = righe.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righe.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

  return (
    <div className="h-screen overflow-hidden p-3">
      <MonitorBoard
        titolo={<>LE MIE<br />PRATICHE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={{
          allertTotali: alertRows.length,
          allertUrgenti: alertRows.filter((r) => r.livello === "critica").length,
          scaduti,
          inScadenzaOggi,
          risoltiOggi: risoltiOggi ?? 0,
          praticheTotali: praticheTotali ?? 0,
        }}
        messaggioVuoto="Nessuna pratica in ritardo al momento: sei in linea con tutte le scadenze."
        mostraSelettoreSchermoIntero={false}
        righeMax={11}
      />
    </div>
  );
}
