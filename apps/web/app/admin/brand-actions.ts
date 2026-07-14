// app/admin/brand-actions.ts
// Server Actions per abilitare/disabilitare un operatore su un brand
// (Arredamenti Cinquegrana / Master Mobili), tabella operatore_brand
// (vedi supabase/migrations/0011_multi_brand.sql).
"use server";

import { revalidatePath } from "next/cache";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

/**
 * Abilita o disabilita un operatore su un brand. Se la riga non esiste
 * ancora in operatore_brand (es. un operatore creato prima di questa
 * migrazione che va abilitato su Master Mobili per la prima volta), la crea;
 * altrimenti aggiorna solo il flag `attivo`.
 */
export async function alternaAbilitazioneBrand(formData: FormData) {
  const operatoreId = String(formData.get("operatore_id") ?? "");
  const brandId = String(formData.get("brand_id") ?? "");
  const nuovoStato = formData.get("nuovo_stato") === "true";
  if (!operatoreId || !brandId) throw new Error("operatore_id e brand_id sono obbligatori");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase
    .from("operatore_brand")
    .upsert(
      { operatore_id: operatoreId, brand_id: brandId, attivo: nuovoStato },
      { onConflict: "operatore_id,brand_id" }
    );
  if (error) throw error;

  revalidatePath("/admin");
}

/**
 * Crea un nuovo brand (es. un'azienda cliente a cui la piattaforma viene
 * ceduta come prodotto separato, come Febal). Il codice va poi usato come
 * BRAND_CODICE negli script di importazione CSV/scraper (vedi
 * .github/workflows/scraper-vamart.yml) e come ?brand= nel cron email (vedi
 * app/api/cron/importa-email/route.ts). Nasce con "Consegna richiesta" = si
 * (comportamento storico): disattivabile dopo dalla tabella qui sopra.
 */
export async function creaBrand(formData: FormData) {
  const codice = String(formData.get("codice") ?? "").trim().toUpperCase();
  const nome = String(formData.get("nome") ?? "").trim();
  const colore = String(formData.get("colore") ?? "").trim() || "#6366f1";

  if (!codice || !nome) throw new Error("Codice e nome sono obbligatori");
  if (!/^[A-Z0-9_]+$/.test(codice)) {
    throw new Error("Il codice può contenere solo lettere maiuscole, numeri e underscore (es. FEBAL)");
  }

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase
    .from("brands")
    .insert({ codice, nome, colore, attivo: true, richiede_consegna_assistenza: true });
  if (error) throw error;

  revalidatePath("/admin");
}

/**
 * Abilita/disabilita, per un intero brand, se una pratica di Assistenza deve
 * aspettare anche "Consegna materiale" prima di potersi chiudere (vedi
 * 0014_richiede_consegna_brand.sql). Default true (comportamento storico)
 * per Cinquegrana e Master Mobili: un brand che non traccia una consegna a
 * parte (es. ritiro diretto in negozio) puo' disattivarlo, cosi' la pratica
 * si chiude gia' quando il materiale risulta arrivato in deposito.
 */
export async function alternaRichiedeConsegnaBrand(formData: FormData) {
  const brandId = String(formData.get("brand_id") ?? "");
  const nuovoStato = formData.get("nuovo_stato") === "true";
  if (!brandId) throw new Error("brand_id obbligatorio");

  const supabase = creaSupabaseClientAdmin();
  const { error } = await supabase
    .from("brands")
    .update({ richiede_consegna_assistenza: nuovoStato })
    .eq("id", brandId);
  if (error) throw error;

  revalidatePath("/admin");
}
