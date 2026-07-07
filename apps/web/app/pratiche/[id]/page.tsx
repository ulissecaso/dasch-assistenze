// app/pratiche/[id]/page.tsx
// Schermata di dettaglio pratica: timeline fasi, righe/articoli, allegati, note, storico.
import { notFound } from "next/navigation";
import { richiediUtente } from "@/lib/auth/richiediUtente";

export const dynamic = "force-dynamic"; // pagina protetta e specifica per utente: mai cache statica/ISR

export default async function PraticaDettaglioPage({ params }: { params: { id: string } }) {
  const { supabase } = await richiediUtente();

  const { data: pratica } = await supabase
    .from("pratiche")
    .select("*, clienti(nome_completo, telefono, email), utenti:operatore_assegnato_id(nome, cognome)")
    .eq("id", params.id)
    .single();

  if (!pratica) return notFound();

  const [{ data: fasi }, { data: righe }, { data: allegati }, { data: storico }] = await Promise.all([
    supabase.from("pratica_fasi").select("*, fasi_workflow(nome, ordine)").eq("pratica_id", params.id).order("fasi_workflow(ordine)"),
    supabase.from("pratica_righe").select("*, fornitori(ragione_sociale)").eq("pratica_id", params.id),
    supabase.from("allegati").select("*").eq("pratica_id", params.id),
    supabase.from("storico_modifiche").select("*").eq("entita_id", params.id).order("modificato_il", { ascending: false }),
  ]);

  return (
    <main className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">
      <section className="lg:col-span-2 space-y-6">
        <header>
          <h1 className="text-2xl font-semibold">Pratica {pratica.codice_commissione}</h1>
          <p className="text-gray-500">{pratica.clienti?.nome_completo} · {pratica.tipo} · assegnata a {pratica.utenti?.nome} {pratica.utenti?.cognome}</p>
        </header>

        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-lg font-medium mb-4">Timeline fasi</h2>
          <ol className="relative border-l border-gray-200 ml-3">
            {(fasi ?? []).map((f: any) => (
              <li key={f.id} className="mb-6 ml-4">
                <div className={`absolute w-3 h-3 rounded-full -left-1.5 border border-white ${
                  f.stato === "completata" ? "bg-green-500" : f.stato === "in_ritardo" ? "bg-red-500" : f.stato === "in_corso" ? "bg-blue-500" : "bg-gray-300"
                }`} />
                <p className="font-medium">{f.fasi_workflow?.nome}</p>
                <p className="text-sm text-gray-500">
                  stato: {f.stato} · prevista: {f.data_prevista ? new Date(f.data_prevista).toLocaleString("it-IT") : "n/d"}
                  {f.data_effettiva && ` · effettiva: ${new Date(f.data_effettiva).toLocaleString("it-IT")}`}
                </p>
                {f.note && <p className="text-sm mt-1 italic">{f.note}</p>}
              </li>
            ))}
          </ol>
        </div>

        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-lg font-medium mb-3">Righe / articoli ({(righe ?? []).length})</h2>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500">
                <th className="py-1">Descrizione</th><th>Fornitore</th><th>Stato</th><th>Consegna prevista</th>
              </tr>
            </thead>
            <tbody>
              {(righe ?? []).map((r: any) => (
                <tr key={r.id} className="border-t">
                  <td className="py-1">{r.descrizione}</td>
                  <td>{r.fornitori?.ragione_sociale}</td>
                  <td>{r.status_riga}</td>
                  <td>{r.data_consegna_prevista ?? "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <aside className="space-y-6">
        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-lg font-medium mb-3">Allegati</h2>
          <ul className="space-y-1 text-sm">
            {(allegati ?? []).map((a: any) => <li key={a.id}>{a.nome_file}</li>)}
            {(allegati ?? []).length === 0 && <li className="text-gray-400">Nessun allegato.</li>}
          </ul>
          {/* Upload: componente client -> Supabase Storage, vedi components/UploadAllegato.tsx */}
        </div>

        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-lg font-medium mb-3">Storico modifiche</h2>
          <ul className="space-y-2 text-xs text-gray-600">
            {(storico ?? []).map((s: any) => (
              <li key={s.id}>{new Date(s.modificato_il).toLocaleString("it-IT")} — {s.campo}: "{s.valore_precedente}" → "{s.valore_nuovo}" ({s.origine})</li>
            ))}
          </ul>
        </div>
      </aside>
    </main>
  );
}
