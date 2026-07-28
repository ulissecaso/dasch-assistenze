// app/pratiche/[id]/page.tsx
// Schermata di dettaglio pratica: timeline fasi, righe/articoli, allegati, note, storico.
import { notFound } from "next/navigation";
import { richiediUtente } from "@/lib/auth/richiediUtente";
import { dichiaraConfermaOrdine, annullaConfermaOrdine, posticipaScadenza } from "./pratica-actions";
import { dichiaraPianificazioneConsegna, annullaPianificazioneConsegna, dichiaraPagamento, annullaPagamento } from "./consegna-actions";

export const dynamic = "force-dynamic";

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
supabase.from("v_percentuale_merce_arrivata").select("percentuale_arrivata, quantita_totale, quantita_arrivata").eq("pratica_id", params.id).maybeSingle(),
]);

const ordineRicambiCompletato = (fasi ?? []).some(
(f: any) => f.fasi_workflow?.codice === "ordine_ricambi" && f.stato === "completata"
);

const domaniIso = new Date(Date.now() + 24 * 3_600_000).toISOString().slice(0, 10);

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

{f.stato !== "completata" && (
<details className="mt-2 text-sm">
<summary className="cursor-pointer text-gray-600 hover:text-gray-800 select-none">
Posticipa scadenza
</summary>
<form action={posticipaScadenza} className="mt-2 space-y-2 max-w-sm">
<input type="hidden" name="pratica_fase_id" value={f.id} />
<input type="hidden" name="pratica_id" value={pratica.id} />
<div>
<label className="block text-xs text-gray-500 mb-0.5">Nuova scadenza</label>
<input
type="date"
name="nuova_data"
min={domaniIso}
required
className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
/>
</div>
<div>
<label className="block text-xs text-gray-500 mb-0.5">Motivo (obbligatorio)</label>
<textarea
name="motivo"
required
rows={2}
placeholder="Es. intervento già programmato per settembre, in attesa di conferma del cliente..."
className="w-full rounded-md border border-gray-300 px-2 py-1 text-sm"
/>
</div>
<button
type="submit"
className="rounded-md bg-gray-700 text-white text-sm font-medium px-3 py-1.5 hover:bg-gray-800"
>
Conferma posticipo
</button>
</form>
</details>
)}

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

{f.fasi_workflow?.codice === "pianificazione_consegna" && f.stato === "in_corso" && (
<form action={dichiaraPianificazioneConsegna} className="mt-2">
<input type="hidden" name="pratica_fase_id" value={f.id} />
<input type="hidden" name="pratica_id" value={pratica.id} />
<p className="text-xs text-amber-700 mb-1">
Da fare solo dopo aver fissato davvero la consegna nel Planning su Vamart.
</p>
<button type="submit" className="rounded-md bg-amber-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-amber-700">
Dichiaro: consegna fissata al planning
</button>
</form>
)}
{f.fasi_workflow?.codice === "pianificazione_consegna" && f.stato === "da_iniziare" && (
<p className="text-xs text-gray-400 italic mt-1">In attesa che la merce risulti tutta arrivata in deposito.</p>
)}
{f.fasi_workflow?.codice === "pianificazione_consegna" && f.stato === "completata" && (
<form action={annullaPianificazioneConsegna} className="mt-1">
<input type="hidden" name="pratica_fase_id" value={f.id} />
<input type="hidden" name="pratica_id" value={pratica.id} />
<button type="submit" className="text-xs text-gray-500 underline hover:text-gray-700">
Annulla dichiarazione (click per errore)
</button>
</form>
)}

{f.fasi_workflow?.codice === "pagamento" && f.stato === "in_corso" && (
<form action={dichiaraPagamento} className="mt-2">
<input type="hidden" name="pratica_fase_id" value={f.id} />
<input type="hidden" name="pratica_id" value={pratica.id} />
<p className="text-xs text-amber-700 mb-1">
Da fare solo dopo aver verificato di persona su Vamart (Statistiche commissioni) che il pagamento è arrivato.
</p>
<button type="submit" className="rounded-md bg-amber-600 text-white text-sm font-medium px-3 py-1.5 hover:bg-amber-700">
Dichiaro: pagamento ricevuto
</button>
</form>
)}
{f.fasi_workflow?.codice === "pagamento" && f.stato === "da_iniziare" && (
<p className="text-xs text-gray-400 italic mt-1">In attesa che la merce risulti tutta arrivata in deposito.</p>
)}
{f.fasi_workflow?.codice === "pagamento" && f.stato === "completata" && (
<form action={annullaPagamento} className="mt-1">
<input type="hidden" name="pratica_fase_id" value={f.id} />
<input type="hidden" name="pratica_id" value={pratica.id} />
<button type="submit" className="text-xs text-gray-500 underline hover:text-gray-700">
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