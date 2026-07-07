// app/dashboard-direzione/page.tsx
// Dashboard direzione: KPI aggregati, pratiche in ritardo, carico per operatore.
import { creaSupabaseClientServer } from "@/lib/supabase/server";

export const revalidate = 60; // ISR leggero: ricalcola KPI ogni minuto

async function caricaDatiDashboard() {
  const supabase = creaSupabaseClientServer();

  const [{ count: aperte }, { count: inRitardo }, { data: perOperatore }, { data: kpiTempi }] = await Promise.all([
    supabase.from("pratiche").select("*", { count: "exact", head: true }).not("stato_generale", "in", '("chiusa","annullata")'),
    supabase.from("v_pratiche_in_ritardo").select("pratica_id", { count: "exact", head: true }),
    supabase.rpc("pratiche_per_operatore"), // funzione SQL di supporto, vedi docs/03-schema-database.md
    supabase.rpc("tempo_medio_chiusura_giorni"),
  ]);

  return { aperte: aperte ?? 0, inRitardo: inRitardo ?? 0, perOperatore: perOperatore ?? [], kpiTempi: kpiTempi ?? null };
}

export default async function DashboardDirezionePage() {
  const { aperte, inRitardo, perOperatore, kpiTempi } = await caricaDatiDashboard();

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard Direzione</h1>

      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <KpiCard titolo="Pratiche aperte" valore={aperte} />
        <KpiCard titolo="Pratiche in ritardo" valore={inRitardo} evidenzia={inRitardo > 0} />
        <KpiCard titolo="Tempo medio chiusura (gg)" valore={kpiTempi ?? "-"} />
        <KpiCard titolo="Operatori attivi" valore={perOperatore.length} />
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Pratiche per operatore</h2>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2">Operatore</th>
              <th>Aperte</th>
              <th>In ritardo</th>
              <th>Chiuse (30gg)</th>
            </tr>
          </thead>
          <tbody>
            {perOperatore.map((riga: any) => (
              <tr key={riga.operatore_id} className="border-t">
                <td className="py-2">{riga.operatore_nome}</td>
                <td>{riga.aperte}</td>
                <td className={riga.in_ritardo > 0 ? "text-red-600 font-medium" : ""}>{riga.in_ritardo}</td>
                <td>{riga.chiuse_30gg}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {/* Filtri e ricerca avanzata: componente client separato per interattività */}
      <FiltriRicercaAvanzata />
    </main>
  );
}

function KpiCard({ titolo, valore, evidenzia = false }: { titolo: string; valore: number | string; evidenzia?: boolean }) {
  return (
    <div className={`rounded-xl shadow p-4 ${evidenzia ? "bg-red-50 border border-red-200" : "bg-white"}`}>
      <p className="text-sm text-gray-500">{titolo}</p>
      <p className={`text-3xl font-semibold ${evidenzia ? "text-red-600" : "text-gray-900"}`}>{valore}</p>
    </div>
  );
}

function FiltriRicercaAvanzata() {
  // Placeholder: da implementare come Client Component con stato per
  // cliente, operatore, stato, intervallo date, categoria, fornitore.
  return (
    <section className="bg-white rounded-xl shadow p-4">
      <h2 className="text-lg font-medium mb-3">Ricerca avanzata</h2>
      <p className="text-sm text-gray-500">Filtri per cliente, operatore, stato, categoria, intervallo date, fornitore (componente client — vedi components/FiltriRicerca.tsx).</p>
    </section>
  );
}
