// app/pratiche/[id]/consegna-actions.ts
// Server Action per le due dichiarazioni manuali del modulo "Consegne":
// "Fissato al planning" (Vamart, https://cinquegrana.azurewebsites.net/Planning)
// e "Pagamento ricevuto" (Vamart, Statistiche > riepilogo commissioni).
// Stesso principio di dichiaraConfermaOrdine/annullaConfermaOrdine per
// l'assistenza: un controllo umano voluto, l'importatore CSV non completa
// mai queste fasi in automatico (vedi sincronizzaFasiConsegna in
// scripts/import-csv/importVamartCsv.mjs e lib/import/eseguiImportazione.ts).
"use server";

import { revalidatePath } from "next/cache";
import { richiediUtente } from "@/lib/auth/richiediUtente";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

type CodiceFaseConsegna = "pianificazione_consegna" | "pagamento";

const ETICHETTE: Record<CodiceFaseConsegna, string> = {
  pianificazione_consegna: "consegna programmata al planning",
  pagamento: "pagamento ricevuto",
};

async function dichiaraFaseConsegna(codiceFase: CodiceFaseConsegna, formData: FormData) {
  const praticaFaseId = String(formData.get("pratica_fase_id") ?? "");
  const praticaId = String(formData.get("pratica_id") ?? "");
  if (!praticaFaseId || !praticaId) throw new Error("Dati mancanti: pratica_fase_id o pratica_id");

  const { user } = await richiediUtente();
  const supabase = creaSupabaseClientAdmin();

  const { data: profilo } = await supabase.from("utenti").select("nome, cognome").eq("id", user.id).maybeSingle();
  const nomeOperatore = profilo ? `${profilo.nome} ${profilo.cognome}` : "operatore";
  const etichetta = ETICHETTE[codiceFase];

  const { data: faseAggiornata, error } = await supabase
    .from("pratica_fasi")
    .update({
      stato: "completata",
      data_effettiva: new Date().toISOString(),
      responsabile_id: user.id,
      note: `Confermato manualmente da ${nomeOperatore} il ${new Date().toLocaleString("it-IT")}: ${etichetta}, verificato di persona su Vamart.`,
    })
    .eq("id", praticaFaseId)
    .eq("pratica_id", praticaId) // difesa in profondita': impedisce di toccare la fase di un'altra pratica
    .select()
    .maybeSingle();
  if (error) throw error;
  if (!faseAggiornata) throw new Error(`Fase '${codiceFase}' non trovata per questa pratica`);

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
  revalidatePath("/dashboard-direzione-consegne");
  revalidatePath("/monitor/consegne");
}

async function annullaFaseConsegna(codiceFase: CodiceFaseConsegna, formData: FormData) {
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
  if (!faseAggiornata) throw new Error(`Fase '${codiceFase}' non trovata (o non era completata) per questa pratica`);

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
  revalidatePath("/dashboard-direzione-consegne");
  revalidatePath("/monitor/consegne");
}

/** "Ho verificato di persona su Vamart (Planning) che la consegna e' stata programmata." */
export async function dichiaraPianificazioneConsegna(formData: FormData) {
  await dichiaraFaseConsegna("pianificazione_consegna", formData);
}
export async function annullaPianificazioneConsegna(formData: FormData) {
  await annullaFaseConsegna("pianificazione_consegna", formData);
}

/** "Ho verificato di persona su Vamart (Statistiche commissioni) che il pagamento e' arrivato." */
export async function dichiaraPagamento(formData: FormData) {
  await dichiaraFaseConsegna("pagamento", formData);
}
export async function annullaPagamento(formData: FormData) {
  await annullaFaseConsegna("pagamento", formData);
}
