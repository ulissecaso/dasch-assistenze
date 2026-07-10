// app/pratiche/[id]/page.tsx
// Schermata di dettaglio pratica: timeline fasi, righe/articoli, allegati, note, storico.
import { notFound } from "next/navigation";
import { richiediUtente } from "@/lib/auth/richiediUtente";
import { dichiaraConfermaOrdine, annullaConfermaOrdine } from "./pratica-actions";

export const dynamic = "force-dynamic"; // pagina protetta e specifica per utente: mai cache statica/ISR

export default async function PraticaDettaglioPage({ params }: { params: { id: string } }) {
  const { supabase } = await richiediUtente();

  const { data: pratica } = await supabase
    .from("pratiche")
    .select("*, clienti(nome_completo, telefono, email), utenti:operatore_assegnato_id(nome, cognome)")
    .eq("id", params.id)
    .single();

  if (!pratica) return notFound();

  const [{ data: fasi }, { data: righe }, { data: allegati }, { data: storico }, { data: percentualeMerce }] = await Promise.all([
    supabase.from("pratica_fasi").select("*, fasi_workflow(codice, nome, ordine)").eq("pratica_id", params.id).order("fasi_workflow(ordine)"),
    supabase.from("pratica_righe").select("*, fornitori(ragione_sociale)").eq("pratica_id", params.id),
    supabase.from("allegati").select("*").eq("pratica_id", params.id),
    supabase.from("storico_modifiche").select("*").eq("entita_id", params.id).order("modificato_il", { ascending: false }),
    // Percentuale di merce arrivata in deposito (quantita_giacente +
    // quantita_consegnata sul totale quantita_venduta), vedi vista
    // v_percentuale_merce_arrivata (migrazione 0009_conferma_ordine.sql).
    supabase.from("v_percentuale_merce_arrivata").select("percentuale_arrivata, quantita_totale, quantita_arrivata").eq("pratica_id", params.id).maybeSingle(),
  ]);

  // Il pulsante "Dichiaro conferma ordine" deve comparire solo dopo che
  // l'ordine ricambi risulta davvero inviato: non ha senso confermare un
  // ordine che non e' stato ancora fatto. Stessa regola e' applicata anche
  // lato server in dichiaraConfermaOrdine (pratica-actions.ts), qui serve
  // solo per decidere cosa mostrare nella pagina.
  const ordineRicambiCompletato = (fasi ?? []).some(
    (f: any) => f.fasi_workflow?.codice === "ordine_ricambi" && f.stato === "completata"
  );

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
                {f.fasi_workflow?.codice === "conferma_ordine" && f.stato !== "completata" && (
                  ordineRicambiCompletato ? (
                    <form action={dichiaraConfermaOrdine} className="mt-2">
                      <input type="hidden" name="pratica_fase_id" value={f.id} />
                      <input type="hidden" name="pratica_id" value={pratica.id} />
                      <p className="text-xs text-amber-700 mb-1">
                        Da fare solo dopo aver verificato di persona che l&#39;ordine è confermato: finché non lo dichiari, l&#39;arrivo merce resta bloccato anche se Vamart lo segnala già.
                      </p>
                      <button
                        type="submit"
                        className="rounded-md bg-amber-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-amber-700"
                      >
                        Dichiaro: conferma ordine ricevuta
                      </button>
                    </form>
                  ) : (
                    <p className="text-xs text-gray-400 italic mt-1">
                      Disponibile solo dopo l&#39;invio dell&#39;ordine ricambi.
                    </p>
                  )
                )}
                {f.fasi_workflow?.codice === "conferma_ordine" && f.stato === "completata" && (
                  <form action={annullaConfermaOrdine} className="mt-1">
                    <input type="hidden" name="pratica_fase_id" value={f.id} />
                    <input type="hidden" name="pratica_id" value={pratica.id} />
                    <button
                      type="submit"
                      className="text-xs text-gray-500 underline hover:text-gray-700"
                    >
                      Annulla dichiarazione (click per errore)
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ol>
        </div>

        <div className="bg-white rounded-xl shadow p-4">
          <h2 className="text-lg font-medium mb-1">Righe / articoli ({(righe ?? []).length})</h2>
          {percentualeMerce && (
            <p className="text-sm text-gray-500 mb-3">
              Merce arrivata in deposito: {percentualeMerce.quantita_arrivata}/{percentualeMerce.quantita_totale} pezzi ({percentualeMerce.percentuale_arrivata}%)
            </p>
          )}
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
