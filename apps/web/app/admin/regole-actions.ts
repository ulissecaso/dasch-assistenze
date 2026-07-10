// app/admin/regole-actions.ts
// Server Actions per la gestione delle regole di assegnazione automatica.
"use server";

import { revalidatePath } from "next/cache";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

export async function creaRegolaAssegnazione(formData: FormData) {
  const nome = String(formData.get("nome") ?? "").trim();
  const valoreDa = String(formData.get("valore_da") ?? "").trim().toUpperCase();
  const valoreA = String(formData.get("valore_a") ?? "").trim().toUpperCase();
  const operatoreId = String(formData.get("operatore_id") ?? "");
  const priorita = Number(formData.get("priorita") ?? 100);
  const tipoPratica = String(formData.get("tipo_pratica") ?? "assistenza");

  if (!nome || !valoreDa || !valoreA || !operatoreId) {
    throw new Error("Tutti i campi sono obbligatori");
  }
  if (!["assistenza", "consegna"].includes(tipoPratica)) {
    throw new Error("Tipo pratica non valido");
  }

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase.from("regole_assegnazione").insert({
    nome,
    criterio: "iniziale_cognome",
    valore_da: valoreDa,
    valore_a: valoreA,
    operatore_id: operatoreId,
    priorita,
    tipo_pratica: tipoPratica,
    attiva: true,
  });
  if (error) throw error;

  revalidatePath("/admin");
}

export async function alternaAttivaRegola(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  const nuovoStato = formData.get("nuovo_stato") === "true";
  if (!id) throw new Error("id mancante");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase.from("regole_assegnazione").update({ attiva: nuovoStato }).eq("id", id);
  if (error) throw error;

  revalidatePath("/admin");
}

/** Elimina definitivamente una regola (usare per doppioni creati per errore). */
export async function eliminaRegolaAssegnazione(formData: FormData) {
  const id = String(formData.get("id") ?? "");
  if (!id) throw new Error("id mancante");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase.from("regole_assegnazione").delete().eq("id", id);
  if (error) throw error;

  revalidatePath("/admin");
}
