// app/dashboard-direzione-consegne/page.tsx
// Monitor Consegne — versione autenticata (dentro al portale admin).
// Per il monitor a parete, senza login, usa /monitor/consegne.
import { richiediVisioneDirezione } from "@/lib/auth/richiediUtente";
import MonitorBoard from "@/components/monitor/MonitorBoard";
import { caricaDatiConsegne } from "@/lib/monitor/caricaDatiConsegne";

export const dynamic = "force-dynamic";

export default async function DashboardDirezioneConsegnePage() {
  const { supabase } = await richiediVisioneDirezione();
  const { alertRows, operatori, stats } = await caricaDatiConsegne(supabase);

  return (
    <div className="h-screen overflow-hidden p-3">
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />CONSEGNE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
        righeMax={11}
        messaggioVuoto="Nessun alert al momento: tutte le consegne sono in linea con le scadenze."
        variante="consegna"
      />
    </div>
  );
}
