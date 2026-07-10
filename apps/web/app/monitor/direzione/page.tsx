// app/monitor/direzione/page.tsx
// Vista pubblica di sola visualizzazione del Monitor Assistenze, pensata per
// il PC collegato al monitor a parete in ufficio: nessun login, nessuna
// sessione admin, nessun link verso il resto del portale. L'accesso è
// protetto da una chiave segreta nell'URL (variabile d'ambiente
// MONITOR_ACCESS_KEY) invece che da autenticazione, perché su quel PC non
// deve mai esistere una sessione con privilegi di amministrazione: chiunque
// sieda a quella tastiera non può comunque raggiungere l'area admin da qui.
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import MonitorBoard from "@/components/monitor/MonitorBoard";
import { caricaDatiDirezione } from "@/lib/monitor/caricaDatiDirezione";

export const dynamic = "force-dynamic";
export const metadata = { robots: { index: false, follow: false } };

export default async function MonitorDirezionePubblico({
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

  // Client con service role: qui non c'è nessuna sessione utente (nessun
  // login su questa pagina), quindi serve un client che bypassa le RLS per
  // poter comunque leggere i dati aggregati da mostrare sul monitor.
  const supabase = creaSupabaseClientAdmin();
  const { alertRows, operatori, stats } = await caricaDatiDirezione(supabase);

  return (
    <div className="h-screen overflow-hidden p-3" style={{ background: "#0a0e16" }}>
      <MonitorBoard
        titolo={<>MONITORAGGIO<br />ASSISTENZE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={stats}
        righeMax={11}
        // Schermo pubblico senza login: nessun link verso il resto del
        // portale (vedi commento in cima a questo file).
        righeCliccabili={false}
      />
    </div>
  );
}
