// app/dashboard-direzione/page.tsx
// Monitor Assistenze — versione autenticata (dentro al portale admin).
// Per il monitor a parete, senza login, usa /monitor/direzione.
import { creaSupabaseClientServer } from "@/lib/supabase/server";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import MonitorBoard from "@/components/monitor/MonitorBoard";
import { caricaDatiDirezione } from "@/lib/monitor/caricaDatiDirezione";

export const dynamic = "force-dynamic";

export default async function DashboardDirezionePage() {
  await richiediAdmin();
  const supabase = creaSupabaseClientServer();
  const { alertRows, operatori, stats } = await caricaDatiDirezione(supabase);

  return (
    <div className="h-screen overflow-hidden p-3">
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />ASSISTENZE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
        righeMax={11}
      />
    </div>
  );
}
