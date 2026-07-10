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
