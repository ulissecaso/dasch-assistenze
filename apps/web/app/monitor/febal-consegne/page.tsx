// app/monitor/febal-consegne/page.tsx
// Vista pubblica di sola visualizzazione del Monitor Consegne, dedicata al
// solo brand Febal - vedi il commento in /monitor/febal-assistenza/page.tsx
// per il motivo (TV/ufficio separato, gruppo aziendale diverso).
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import MonitorBoard from "@/components/monitor/MonitorBoard";
import { caricaDatiConsegne } from "@/lib/monitor/caricaDatiConsegne";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function MonitorFebalConsegnePubblico({
  searchParams,
}: {
  searchParams: { chiave?: string };
}) {
  const chiaveAttesa = process.env.MONITOR_ACCESS_KEY;
  const chiaveFornita = searchParams?.chiave;

  if (!chiaveAttesa || chiaveFornita !== chiaveAttesa) {
    return (
      <div style={{ background: "#0a0e16", color: "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", height: "100vh", fontFamily: "sans-serif", margin: 0 }}>
        <p>Accesso non autorizzato.</p>
      </div>
    );
  }

  const supabase = creaSupabaseClientAdmin();
  const { alertRows, operatori, stats, avvisiImportazione } = await caricaDatiConsegne(supabase, { soloBrandCodici: ["FEBAL"] });

  return (
    <div className="h-screen overflow-hidden p-3" style={{ background: "#0a0e16" }}>
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />CONSEGNE FEBAL</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
        righeMax={11}
        messaggioVuoto="Nessun alert al momento: tutte le consegne sono in linea con le scadenze."
        righeCliccabili={false}
        variante="consegna"
        avvisiImportazione={avvisiImportazione}
      />
    </div>
  );
}
