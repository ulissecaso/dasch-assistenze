// app/admin/operatori-actions.ts
// Server Actions per la gestione di operatori/admin dal pannello.
"use server";

import { revalidatePath } from "next/cache";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import { emailSinteticaDaCodice } from "@/lib/auth/codiceOperatore";

const ALFABETO_CODICE = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // esclusi 0/O/1/I per leggibilita

function generaCodice(lunghezza = 8): string {
  let codice = "";
  for (let i = 0; i < lunghezza; i++) {
    codice += ALFABETO_CODICE[Math.floor(Math.random() * ALFABETO_CODICE.length)];
  }
  return codice;
}

/**
 * Crea un nuovo operatore: genera un codice univoco, crea l'utente Supabase
 * Auth "sotto al cofano" (email sintetica + codice come password) e la riga
 * corrispondente in `utenti`. Il codice generato va comunicato a voce/su
 * carta all'operatore: è quello che userà per accedere all'app.
 */
export async function creaOperatore(formData: FormData) {
  const nome = String(formData.get("nome") ?? "").trim();
  const cognome = String(formData.get("cognome") ?? "").trim();
  const ruolo = String(formData.get("ruolo") ?? "operatore");

  if (!nome || !cognome) {
    throw new Error("Nome e cognome sono obbligatori");
  }

  const supabase = creaSupabaseClientAdmin();

  // Genera un codice univoco (riprova in caso di rarissima collisione).
  let codice = generaCodice();
  for (let tentativo = 0; tentativo < 5; tentativo++) {
    const { data: esistente } = await supabase.from("utenti").select("id").eq("codice_accesso", codice).maybeSingle();
    if (!esistente) break;
    codice = generaCodice();
  }

  const email = emailSinteticaDaCodice(codice);

  const { data: nuovoAuthUser, error: erroreAuth } = await supabase.auth.admin.createUser({
    email,
    password: codice,
    email_confirm: true,
  });
  if (erroreAuth) throw erroreAuth;

  const { error: erroreUtente } = await supabase.from("utenti").insert({
    id: nuovoAuthUser.user.id,
    nome,
    cognome,
    email,
    ruolo,
    codice_accesso: codice,
    attivo: true,
  });
  if (erroreUtente) throw erroreUtente;

  revalidatePath("/admin");
}

/** Crea l'account admin (email + password vera, comunicata da voi all'amministratore). */
export async function creaAdmin(formData: FormData) {
  const nome = String(formData.get("nome") ?? "").trim();
  const cognome = String(formData.get("cognome") ?? "").trim();
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "").trim();
  const ruolo = String(formData.get("ruolo") ?? "admin");

  if (!nome || !cognome || !email || !password) {
    throw new Error("Nome, cognome, email e password sono obbligatori");
  }
  if (password.length < 6) {
    throw new Error("La password deve avere almeno 6 caratteri");
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: nuovoAuthUser, error: erroreAuth } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (erroreAuth) throw erroreAuth;

  const { error: erroreUtente } = await supabase.from("utenti").insert({
    id: nuovoAuthUser.user.id,
    nome,
    cognome,
    email,
    ruolo,
    attivo: true,
  });
  if (erroreUtente) throw erroreUtente;

  revalidatePath("/admin");
}

/** Disattiva/riattiva un utente (non elimina, per preservare lo storico). */
export async function alternaAttivoUtente(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const nuovoStato = formData.get("nuovo_stato") === "true";
  if (!id) throw new Error("id mancante");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase.from("utenti").update({ attivo: nuovoStato }).eq("id", id);
  if (error) throw error;

  revalidatePath("/admin");
}

/** Cambia la password di un admin/responsabile (accesso con email). Azione
 *  sensibile: richiediAdmin() e' ripetuta qui (a differenza delle altre
 *  Server Action di questo file) perche' un cambio password e' equivalente
 *  a un potenziale furto di account, quindi vale la pena la difesa in piu'. */
export async function cambiaPasswordAdmin(formData: FormData) {
  await richiediAdmin();

  const id = String(formData.get("id") ?? "");
  const password = String(formData.get("password") ?? "").trim();
  if (!id) throw new Error("id mancante");
  if (password.length < 6) throw new Error("La password deve avere almeno 6 caratteri");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase.auth.admin.updateUserById(id, { password });
  if (error) throw error;

  revalidatePath("/admin");
}

/** Elimina DEFINITIVAMENTE un operatore/utente: irreversibile.
 *
 *  Doppia protezione (stesso principio di eliminaDefinitivamentePratica in
 *  pratiche-actions.ts):
 *   1. Consentita SOLO su utenti già disattivati (va prima disattivato con
 *      "Disattiva", poi eventualmente eliminato: non si elimina direttamente
 *      un utente ancora attivo).
 *   2. Il form che chiama questa azione richiede una checkbox di conferma
 *      esplicita (vedi app/admin/page.tsx).
 *
 *  Prima di cancellare la riga in `utenti` e l'utente Supabase Auth,
 *  ripuliamo tutti i riferimenti che altrimenti bloccherebbero la DELETE per
 *  vincolo di chiave esterna o che perderebbero senso restando orfani:
 *   - operatore_brand: cascade automatico (0011_multi_brand.sql), nessuna
 *     azione manuale necessaria.
 *   - regole_assegnazione: operatore_id è NOT NULL, non si può "scollegare",
 *     quindi le regole di questo operatore vengono eliminate insieme a lui
 *     (l'admin dovrà ricrearle su un altro operatore se servono ancora).
 *   - notifiche: utente_id è NOT NULL, eliminate insieme all'utente.
 *   - pratiche.operatore_assegnato_id, storico_modifiche.modificato_da,
 *     allegati.caricato_da: colonne nullable, impostate a null così le
 *     pratiche/storico restano intatti ma "non assegnati".
 */
export async function eliminaOperatore(formData: FormData) {
  const { user } = await richiediAdmin();

  const id = String(formData.get("id") ?? "");
  const confermato = formData.get("conferma") === "si";
  if (!id || !confermato) {
    throw new Error("Conferma mancante: serve spuntare la casella di conferma per eliminare definitivamente.");
  }
  if (id === user.id) {
    throw new Error("Non puoi eliminare il tuo stesso account da qui.");
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: utente } = await supabase.from("utenti").select("nome, cognome, attivo").eq("id", id).maybeSingle();
  if (!utente) throw new Error("Utente non trovato");
  if (utente.attivo) {
    throw new Error("Si può eliminare definitivamente solo un utente già disattivato. Disattivalo prima, poi elimina.");
  }

  await supabase.from("pratiche").update({ operatore_assegnato_id: null }).eq("operatore_assegnato_id", id);
  await supabase.from("storico_modifiche").update({ modificato_da: null }).eq("modificato_da", id);
  await supabase.from("allegati").update({ caricato_da: null }).eq("caricato_da", id);
  await supabase.from("regole_assegnazione").delete().eq("operatore_id", id);
  await supabase.from("notifiche").delete().eq("utente_id", id);

  const { error: erroreAuth } = await supabase.auth.admin.deleteUser(id);
  if (erroreAuth) throw erroreAuth;

  const { error: erroreUtente } = await supabase.from("utenti").delete().eq("id", id);
  if (erroreUtente) throw erroreUtente;

  revalidatePath("/admin");
}

/** Rigenera il codice di accesso di un operatore (equivale a "cambia
 *  password": per gli operatori il codice E' la password, vedi creaOperatore
 *  sopra). Il vecchio codice smette immediatamente di funzionare; il nuovo
 *  va comunicato all'operatore (visibile dopo con "mostra codice"). */
export async function rigeneraCodiceOperatore(formData: FormData) {
  await richiediAdmin();

  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id mancante");

  const supabase = creaSupabaseClientAdmin();

  let codice = generaCodice();
  for (let tentativo = 0; tentativo < 5; tentativo++) {
    const { data: esistente } = await supabase.from("utenti").select("id").eq("codice_accesso", codice).maybeSingle();
    if (!esistente) break;
    codice = generaCodice();
  }

  const { error: erroreAuth } = await supabase.auth.admin.updateUserById(id, { password: codice });
  if (erroreAuth) throw erroreAuth;

  const { error: erroreUtente } = await supabase.from("utenti").update({ codice_accesso: codice }).eq("id", id);
  if (erroreUtente) throw erroreUtente;

  revalidatePath("/admin");
}
