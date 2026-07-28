// app/pratiche/[id]/pratica-actions.ts
// Server Action per la dichiarazione manuale "Conferma ordine ricevuta" e
// per il posticipo manuale di una scadenza (vedi posticipaScadenza in fondo
// al file).
"use server";

import { revalidatePath } from "next/cache";
import { richiediUtente } from "@/lib/auth/richiediUtente";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

/** Dichiarazione manuale dell'operatore: "ho verificato di persona che
* l'ordine e' confermato". Finche' questa fase non risulta completata,
* l'importatore CSV blocca l'avanzamento di "Arrivo merce in deposito"
* anche se Vamart segnala gia' merce arrivata (vedi importVamartCsv.mjs,
* funzione sincronizzaFasiDaRighe). E' un controllo umano voluto: per
* questo non basta un dato letto dal CSV, serve un'azione esplicita
* dell'operatore su questa pagina. */
export async function dichiaraConfermaOrdine(formData: FormData) {
const praticaFaseId = String(formData.get("pratica_fase_id") ?? "");
const praticaId = String(formData.get("pratica_id") ?? "");
if (!praticaFaseId || !praticaId) throw new Error("Dati mancanti: pratica_fase_id o pratica_id");

const { user } = await richiediUtente();
const supabase = creaSupabaseClientAdmin();

const { data: faseOrdineRicambi } = await supabase
.from("pratica_fasi")
.select("stato, fasi_workflow!inner(codice)")
.eq("pratica_id", praticaId)
.eq("fasi_workflow.codice", "ordine_ricambi")
.maybeSingle();
if (!faseOrdineRicambi || faseOrdineRicambi.stato !== "completata") {
throw new Error("Non puoi dichiarare la conferma ordine prima che l'invio ordine ricambi risulti completato.");
}

const { data: profilo } = await supabase.from("utenti").select("nome, cognome").eq("id", user.id).maybeSingle();
const nomeOperatore = profilo ? `${profilo.nome} ${profilo.cognome}` : "operatore";

const { data: faseAggiornata, error } = await supabase
.from("pratica_fasi")
.update({
stato: "completata",
data_effettiva: new Date().toISOString(),
responsabile_id: user.id,
note: `Confermato manualmente da ${nomeOperatore} il ${new Date().toLocaleString("it-IT")}: conferma ordine ricevuta e verificata di persona.`,
})
.eq("id", praticaFaseId)
.eq("pratica_id", praticaId)
.select()
.maybeSingle();
if (error) throw error;
if (!faseAggiornata) throw new Error("Fase 'conferma ordine' non trovata per questa pratica");

await supabase.from("storico_modifiche").insert({
entita: "pratica_fasi",
entita_id: praticaFaseId,
campo: "stato",
valore_precedente: "in_corso",
valore_nuovo: `completata (dichiarato da ${nomeOperatore})`,
origine: "utente",
modificato_da: user.id,
});

revalidatePath(`/pratiche/${praticaId}`);
revalidatePath("/dashboard-operatore");
revalidatePath("/monitor/direzione");
}

/** Annulla una dichiarazione di "conferma ordine" fatta per errore. */
export async function annullaConfermaOrdine(formData: FormData) {
const praticaFaseId = String(formData.get("pratica_fase_id") ?? "");
const praticaId = String(formData.get("pratica_id") ?? "");
if (!praticaFaseId || !praticaId) throw new Error("Dati mancanti: pratica_fase_id o pratica_id");

const { user } = await richiediUtente();
const supabase = creaSupabaseClientAdmin();

const { data: profilo } = await supabase.from("utenti").select("nome, cognome").eq("id", user.id).maybeSingle();
const nomeOperatore = profilo ? `${profilo.nome} ${profilo.cognome}` : "operatore";

const { data: faseAggiornata, error } = await supabase
.from("pratica_fasi")
.update({
stato: "in_corso",
data_effettiva: null,
note: `Dichiarazione annullata da ${nomeOperatore} il ${new Date().toLocaleString("it-IT")}: probabile click per errore, in attesa di una nuova conferma.`,
})
.eq("id", praticaFaseId)
.eq("pratica_id", praticaId)
.eq("stato", "completata")
.select()
.maybeSingle();
if (error) throw error;
if (!faseAggiornata) throw new Error("Fase 'conferma ordine' non trovata (o non era completata) per questa pratica");

await supabase.from("storico_modifiche").insert({
entita: "pratica_fasi",
entita_id: praticaFaseId,
campo: "stato",
valore_precedente: "completata",
valore_nuovo: `in_corso (annullato da ${nomeOperatore})`,
origine: "utente",
modificato_da: user.id,
});

revalidatePath(`/pratiche/${praticaId}`);
revalidatePath("/dashboard-operatore");
revalidatePath("/monitor/direzione");
}

/** NUOVO (28/07/2026, richiesto dagli operatori): permette di posticipare
* manualmente la scadenza di una fase NON ancora completata, con un motivo
* obbligatorio. Serve a fermare davvero il conto alla rovescia quando il
* lavoro e' gia' stato preso in carico fuori dal Dash (telefono, Planning
* Vamart, attesa cliente). Non tocca lo stato della fase, solo
* data_prevista e nota, e azzera il ciclo di alert gia' inviato per questa
* fase su questa pratica (stesso principio di riavviaContoConfermaOrdine
* in scripts/import-csv/importVamartCsv.mjs). */
export async function posticipaScadenza(formData: FormData) {
const praticaFaseId = String(formData.get("pratica_fase_id") ?? "");
const praticaId = String(formData.get("pratica_id") ?? "");
const nuovaDataStr = String(formData.get("nuova_data") ?? "");
const motivo = String(formData.get("motivo") ?? "").trim();

if (!praticaFaseId || !praticaId) throw new Error("Dati mancanti: pratica_fase_id o pratica_id");
if (!motivo) throw new Error("Il motivo del posticipo è obbligatorio: serve a chi controllerà in seguito di capire perché l'alert è stato fermato.");
if (!nuovaDataStr) throw new Error("La nuova data è obbligatoria.");

const nuovaData = new Date(nuovaDataStr);
if (Number.isNaN(nuovaData.getTime())) throw new Error("Data non valida.");
if (nuovaData.getTime() <= Date.now()) throw new Error("La nuova data deve essere nel futuro: per una scadenza già passata non ha senso posticipare.");

const { user } = await richiediUtente();
const supabase = creaSupabaseClientAdmin();

const { data: profilo } = await supabase.from("utenti").select("nome, cognome").eq("id", user.id).maybeSingle();
const nomeOperatore = profilo ? `${profilo.nome} ${profilo.cognome}` : "operatore";

const { data: faseAttuale } = await supabase
.from("pratica_fasi")
.select("id, fase_id, stato, data_prevista")
.eq("id", praticaFaseId)
.eq("pratica_id", praticaId)
.maybeSingle();
if (!faseAttuale) throw new Error("Fase non trovata per questa pratica.");
if (faseAttuale.stato === "completata") throw new Error("Questa fase è già completata: non ha senso posticiparla.");

const dataPrecedente = faseAttuale.data_prevista;
const notaPosticipo = `Posticipata manualmente da ${nomeOperatore} il ${new Date().toLocaleString("it-IT")} a ${nuovaData.toLocaleString("it-IT")}. Motivo: ${motivo}`;

const { error } = await supabase
.from("pratica_fasi")
.update({
data_prevista: nuovaData.toISOString(),
note: notaPosticipo,
})
.eq("id", praticaFaseId)
.eq("pratica_id", praticaId);
if (error) throw error;

await supabase.from("storico_modifiche").insert({
entita: "pratica_fasi",
entita_id: praticaFaseId,
campo: "data_prevista",
valore_precedente: dataPrecedente,
valore_nuovo: `${nuovaData.toISOString()} (posticipata da ${nomeOperatore}: ${motivo})`,
origine: "utente",
modificato_da: user.id,
});

const { data: regoleFase } = await supabase.from("regole_alert").select("id").eq("fase_id", faseAttuale.fase_id);
const idsRegole = (regoleFase ?? []).map((r) => r.id);
if (idsRegole.length > 0) {
await supabase.from("alert_occorrenze").delete().eq("pratica_id", praticaId).in("regola_alert_id", idsRegole);
}

revalidatePath(`/pratiche/${praticaId}`);
revalidatePath("/dashboard-operatore");
revalidatePath("/monitor/direzione");
}
