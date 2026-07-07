// app/dashboard-operatore/page.tsx
// Dashboard operatore: pratiche assegnate, priorità, scadenze, alert del giorno.
import { creaSupabaseClientServer } from "@/lib/supabase/server";

export default async function DashboardOperatorePage() {
  const supabase = creaSupabaseClientServer();
  const { data: { user } } = await supabase.auth.getUser();

  const { data: pratiche } = await supabase
    .from("pratiche")
    .select("id, codice_commissione, tipo, priorita, stato_generale, data_consegna_prevista, clienti(nome_completo)")
    .eq("operatore_assegnato_id", user?.id)
    .not("stato_generale", "in", '("chiusa","annullata")')
    .order("priorita", { ascending: false })
    .order("data_consegna_prevista", { ascending: true });

  const { data: notifiche } = await supabase
    .from("notifiche")
    .select("*")
    .eq("utente_id", user?.id)
    .eq("letta", false)
    .order("created_at", { ascending: false })
    .limit(10);

  return (
    <main className="p-6 space-y-6">
      <h1 className="text-2xl font-semibold">Le mie pratiche</h1>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Alert e notifiche</h2>
        <ul className="space-y-2">
          {(notifiche ?? []).map((n) => (
            <li key={n.id} className={`text-sm p-2 rounded ${n.tipo === "escalation" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700"}`}>
              {n.titolo}: {n.messaggio}
            </li>
          ))}
          {(notifiche ?? []).length === 0 && <li className="text-sm text-gray-400">Nessuna notifica non letta.</li>}
        </ul>
      </section>

      <section className="bg-white rounded-xl shadow p-4">
        <h2 className="text-lg font-medium mb-3">Pratiche assegnate</h2>
        <div className="grid gap-3">
          {(pratiche ?? []).map((p: any) => (
            <a key={p.id} href={`/pratiche/${p.id}`} className="border rounded-lg p-3 hover:shadow-md transition-shadow flex justify-between items-center">
              <div>
                <p className="font-medium">{p.codice_commissione} — {p.clienti?.nome_completo}</p>
                <p className="text-sm text-gray-500">{p.tipo} · scadenza {p.data_consegna_prevista ?? "n/d"}</p>
              </div>
              <span className={`text-xs px-2 py-1 rounded-full ${
                p.priorita === "urgente" ? "bg-red-100 text-red-700" :
                p.priorita === "alta" ? "bg-orange-100 text-orange-700" : "bg-gray-100 text-gray-600"
              }`}>{p.priorita}</span>
            </a>
          ))}
        </div>
      </section>
    </main>
  );
}
