// app/monitor/febal-assistenza/page.tsx
// Vista pubblica di sola visualizzazione del Monitor Assistenze, dedicata al
// solo brand Febal: Febal ha una propria TV/monitor in un ufficio separato e
// appartiene a un gruppo aziendale diverso da Cinquegrana/Master Mobili,
// quindi non deve comparire su /monitor/direzione (la dasch "generale" di
// quei due brand) e viceversa questa pagina non mostra mai Cinquegrana/
// Master Mobili. Stessa logica di accesso (chiave segreta in URL, variabile
// MONITOR_ACCESS_KEY) delle altre pagine /monitor/*: vedi il commento in
// /monitor/direzione/page.tsx per il perche'.
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import MonitorBoard from "@/components/monitor/MonitorBoard";
import { caricaDatiDirezione } from "@/lib/monitor/caricaDatiDirezione";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function MonitorFebalAssistenzaPubblico({
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
  const { alertRows, operatori, stats, avvisiImportazione } = await caricaDatiDirezione(supabase, { soloBrandCodici: ["FEBAL"] });

  return (
    <div className="h-screen overflow-hidden p-3" style={{ background: "#0a0e16" }}>
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />ASSISTENZE FEBAL</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
        righeMax={11}
        righeCliccabili={false}
        variante="assistenza"
        avvisiImportazione={avvisiImportazione}
      />
    </div>
  );
}
