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
