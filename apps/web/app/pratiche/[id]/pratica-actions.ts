// app/pratiche/[id]/pratica-actions.ts
// Server Action per la dichiarazione manuale "Conferma ordine ricevuta".
"use server";

import { revalidatePath } from "next/cache";
import { richiediUtente } from "@/lib/auth/richiediUtente";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

/** Dichiarazione manuale dell'operatore: "ho verificato di persona che
 *  l'ordine e' confermato". Finche' questa fase non risulta completata,
 *  l'importatore CSV blocca l'avanzamento di "Arrivo merce in deposito"
 *  anche se Vamart segnala gia' merce arrivata (vedi importVamartCsv.mjs,
 *  funzione sincronizzaFasiDaRighe). E' un controllo umano voluto: per
 *  questo non basta un dato letto dal CSV, serve un'azione esplicita
 *  dell'operatore su questa pagina. */
export async function dichiaraConfermaOrdine(formData: FormData) {
  const praticaFaseId = String(formData.get("pratica_fase_id") ?? "");
  const praticaId = String(formData.get("pratica_id") ?? "");
  if (!praticaFaseId || !praticaId) throw new Error("Dati mancanti: pratica_fase_id o pratica_id");

  // richiediUtente garantisce che solo un utente autenticato possa arrivare
  // qui (le Server Action sono endpoint invocabili anche fuori dal render
  // della pagina, quindi il controllo va ripetuto anche se la pagina lo fa
  // gia'). La scrittura vera e propria usa pero' il client admin, come
  // tutte le altre Server Action del progetto (vedi app/admin/*-actions.ts):
  // pratica_fasi ha RLS abilitata ma, ad oggi, solo con policy di lettura
  // (migrazione 0005), non di scrittura, quindi un client legato alla sola
  // sessione utente verrebbe bloccato dal database.
  const { user } = await richiediUtente();
  const supabase = creaSupabaseClientAdmin();

  // Difesa in profondita': non permettere di dichiarare la conferma ordine
  // se l'ordine ricambi non risulta ancora completato. La pagina gia'
  // nasconde il pulsante in questo caso, ma il controllo va ripetuto qui
  // perche' le Server Action sono endpoint invocabili anche fuori dal
  // render della pagina.
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
    .eq("pratica_id", praticaId) // difesa in profondita': impedisce di toccare la fase di un'altra pratica passando un id a caso nel form
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!faseAggiornata) throw new Error("Fase 'conferma ordine' non trovata per questa pratica");

  // origine deve rispettare il vincolo della tabella (solo 'utente',
  // 'importazione_csv', 'importazione_api', 'automazione'): il "chi" va
  // invece nel campo modificato_da (id) e nel testo di valore_nuovo, non
  // in un valore custom per origine (violerebbe il check e l'insert
  // fallirebbe silenziosamente, come succedeva prima di questa correzione).
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

/** Annulla una dichiarazione di "conferma ordine" fatta per errore: riporta
 *  la fase a "in_corso" (non a "da_iniziare", perche' l'importatore CSV
 *  l'aveva gia' attivata automaticamente quando tutte le righe risultavano
 *  ordinate - vedi importVamartCsv.mjs) cosi' l'operatore puo' dichiararla
 *  di nuovo quando avra' davvero verificato la conferma. Il trigger
 *  trg_pratica_fasi_avvia_cronometro fa ripartire automaticamente il
 *  cronometro (data_prevista) quando lo stato torna a "in_corso". */
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
    .eq("stato", "completata") // si puo' annullare solo una dichiarazione gia' fatta
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
