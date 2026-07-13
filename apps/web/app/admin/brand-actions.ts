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
