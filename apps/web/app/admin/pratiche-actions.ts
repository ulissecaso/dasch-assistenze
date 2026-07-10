// app/admin/pratiche-actions.ts
// Server Action per annullare (o riattivare) una pratica dal pannello admin.
// Riservata esplicitamente a admin/responsabile: l'operatore non deve poter
// rimuovere una pratica da solo, deve sempre passare dal responsabile.
"use server";

import { revalidatePath } from "next/cache";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

/** Annulla (o riattiva) una pratica: non la cancella mai fisicamente dal
 *  database. Imposta solo stato_generale = 'annullata' (valore gia'
 *  previsto dallo schema fin dalla migrazione 0001_init.sql), cosi'
 *  sparisce da tutti i conteggi/dashboard (che escludono sempre 'chiusa' e
 *  'annullata' - vedi caricaDatiDirezione.ts, dashboard-operatore/page.tsx,
 *  le viste KPI...) ma resta recuperabile e tracciata nello storico. Una
 *  DELETE fisica perderebbe righe, allegati e storico legati e non sarebbe
 *  reversibile in caso di errore.
 *
 *  richiediAdmin() blocca chiunque non sia admin/responsabile: e' lo stesso
 *  controllo gia' usato per accedere alla pagina /admin, ripetuto qui perche'
 *  le Server Action sono endpoint invocabili anche fuori dal render della
 *  pagina (stessa logica di difesa in profondita' usata in pratica-actions.ts).
 */
export async function alternaAnnullataPratica(formData: FormData) {
  const { user } = await richiediAdmin();

  const praticaId = String(formData.get("pratica_id") ?? "");
  const nuovoStato = String(formData.get("nuovo_stato") ?? "");
  if (!praticaId || !["annullata", "aperta"].includes(nuovoStato)) {
    throw new Error("Dati mancanti o non validi");
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: profilo } = await supabase.from("utenti").select("nome, cognome").eq("id", user.id).maybeSingle();
  const nomeAdmin = profilo ? `${profilo.nome} ${profilo.cognome}` : "admin";

  const { data: praticaPrima } = await supabase
    .from("pratiche")
    .select("stato_generale")
    .eq("id", praticaId)
    .maybeSingle();
  if (!praticaPrima) throw new Error("Pratica non trovata");

  const { error } = await supabase.from("pratiche").update({ stato_generale: nuovoStato }).eq("id", praticaId);
  if (error) throw error;

  await supabase.from("storico_modifiche").insert({
    entita: "pratiche",
    entita_id: praticaId,
    campo: "stato_generale",
    valore_precedente: praticaPrima.stato_generale,
    valore_nuovo: `${nuovoStato} (da admin ${nomeAdmin})`,
    origine: "utente",
    modificato_da: user.id,
  });

  revalidatePath("/admin");
  revalidatePath("/dashboard-direzione");
  revalidatePath("/dashboard-operatore");
  revalidatePath("/monitor/direzione");
  revalidatePath(`/pratiche/${praticaId}`);
}

/** Elimina FISICAMENTE una pratica dal database: irreversibile, a differenza
 *  di alternaAnnullataPratica (soft-delete). Pensata per liberare la lista da
 *  pratiche di prova/test create per errore, che non ha senso tenere nemmeno
 *  come "annullata".
 *
 *  Doppia protezione:
 *   1. Consentita SOLO su pratiche gia' in stato 'annullata' (l'admin deve
 *      prima annullarla dalla azione sopra, poi eventualmente eliminarla: non
 *      si puo' eliminare direttamente una pratica ancora attiva).
 *   2. Il form che chiama questa azione richiede una checkbox di conferma
 *      esplicita (vedi app/admin/page.tsx), quindi il click da solo non basta.
 *
 *  pratica_fasi, pratica_righe e allegati hanno "on delete cascade" verso
 *  pratiche (migrazione 0001_init.sql): spariscono automaticamente insieme
 *  alla pratica. notifiche e importazioni_email referenziano pratica_id SENZA
 *  cascade: li scolleghiamo esplicitamente prima, altrimenti la DELETE
 *  fallirebbe per violazione di chiave esterna. storico_modifiche non ha un
 *  vincolo di chiave esterna verso pratiche (riferimento generico
 *  entita/entita_id): le righe restano come traccia storica anche dopo la
 *  cancellazione, e' corretto cosi' per un log di controllo. */
export async function eliminaDefinitivamentePratica(formData: FormData) {
  const { user } = await richiediAdmin();

  const praticaId = String(formData.get("pratica_id") ?? "");
  const confermato = formData.get("conferma") === "si";
  if (!praticaId || !confermato) {
    throw new Error("Conferma mancante: serve spuntare la casella di conferma per eliminare definitivamente.");
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: pratica } = await supabase
    .from("pratiche")
    .select("stato_generale, codice_commissione")
    .eq("id", praticaId)
    .maybeSingle();
  if (!pratica) throw new Error("Pratica non trovata");
  if (pratica.stato_generale !== "annullata") {
    throw new Error("Si puo' eliminare definitivamente solo una pratica gia' annullata. Annullala prima, poi elimina.");
  }

  // Scollega i riferimenti senza cascade prima di cancellare la pratica.
  await supabase.from("notifiche").delete().eq("pratica_id", praticaId);
  await supabase.from("importazioni_email").update({ pratica_id: null }).eq("pratica_id", praticaId);

  const { error } = await supabase.from("pratiche").delete().eq("id", praticaId);
  if (error) throw error;

  // Log dell'eliminazione stessa (non sulla pratica, ormai sparita, ma come
  // evento generico riconducibile all'admin che l'ha eseguita).
  await supabase.from("storico_modifiche").insert({
    entita: "pratiche",
    entita_id: praticaId,
    campo: "eliminazione_definitiva",
    valore_precedente: pratica.codice_commissione,
    valore_nuovo: "eliminata definitivamente",
    origine: "utente",
    modificato_da: user.id,
  });

  revalidatePath("/admin");
  revalidatePath("/dashboard-direzione");
  revalidatePath("/dashboard-operatore");
  revalidatePath("/monitor/direzione");
}
