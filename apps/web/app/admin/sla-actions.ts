// app/admin/sla-actions.ts
// Server Action: aggiorna le soglie di una catena di alert (Primo/Secondo/Periodico)
// per una singola fase, dal pannello admin. Usa il client con service role key
// perché regole_alert non è (ancora) coperta da policy RLS dedicate — l'accesso
// a questa pagina va protetto a livello di autenticazione/ruolo quando l'auth
// sarà collegata.
"use server";

import { revalidatePath } from "next/cache";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

function combinaInOre(giorni: FormDataEntryValue | null, ore: FormDataEntryValue | null) {
  const g = Number(giorni ?? 0) || 0;
  const o = Number(ore ?? 0) || 0;
  return g * 24 + o;
}

export async function aggiornaRegoleFase(formData: FormData) {
  const supabase = creaSupabaseClientAdmin();

  const primoId = formData.get("primo_id") as string | null;
  const secondoId = formData.get("secondo_id") as string | null;
  const periodicoId = formData.get("periodico_id") as string | null;

  const primoOre = combinaInOre(formData.get("primo_giorni"), formData.get("primo_ore"));
  const secondoOre = combinaInOre(formData.get("secondo_giorni"), formData.get("secondo_ore"));
  const intervalloOre = combinaInOre(formData.get("intervallo_giorni"), formData.get("intervallo_ore"));
  const tettoRaw = formData.get("tetto");
  const tetto = tettoRaw && String(tettoRaw).trim() !== "" ? Number(tettoRaw) : null;

  const scritture: Promise<any>[] = [];

  if (primoId) {
    scritture.push(
      supabase.from("regole_alert").update({ soglia_valore: primoOre, soglia_unita: "ore" }).eq("id", primoId)
    );
  }
  if (secondoId) {
    scritture.push(
      supabase.from("regole_alert").update({ soglia_valore: secondoOre, soglia_unita: "ore" }).eq("id", secondoId)
    );
  }
  if (periodicoId) {
    // Il periodico parte sempre alla stessa soglia del Secondo Allert (non è
    // un valore indipendente): lo teniamo sincronizzato automaticamente.
    scritture.push(
      supabase.from("regole_alert").update({
        soglia_valore: secondoOre,
        soglia_unita: "ore",
        ripeti_ogni_valore: intervalloOre,
        ripeti_ogni_unita: "ore",
        ripeti_max_volte: tetto,
      }).eq("id", periodicoId)
    );
  }

  await Promise.all(scritture);
  revalidatePath("/admin");
}
