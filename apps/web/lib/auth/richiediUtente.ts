// lib/auth/richiediUtente.ts
// Guard di autenticazione a livello di pagina (Server Component). Da usare
// come seconda rete di sicurezza oltre al middleware: se per qualsiasi
// motivo il middleware non blocca la richiesta (propagazione edge, cache,
// bug futuro), la pagina stessa reindirizza al login. Non deve mai essere
// l'unico controllo, ma nemmeno un controllo "opzionale".
import { redirect } from "next/navigation";
import { creaSupabaseClientServer } from "@/lib/supabase/server";

/** Richiede un utente autenticato (qualsiasi ruolo). Reindirizza al login operatore se assente. */
export async function richiediUtente() {
  const supabase = creaSupabaseClientServer();
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;
  if (!user || error) {
    redirect("/login/operatore");
  }
  return { supabase, user };
}

/** Richiede un utente con ruolo admin/responsabile. Reindirizza altrimenti.
 *  Usata dal pannello /admin e da tutte le Server Action che modificano
 *  qualcosa: il ruolo 'supervisore' (sola lettura) non deve mai passare
 *  questo controllo. */
export async function richiediAdmin() {
  const supabase = creaSupabaseClientServer();
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;
  if (!user || error) {
    redirect("/login/admin");
  }

  const { data: profilo } = await supabase.from("utenti").select("ruolo").eq("id", user!.id).maybeSingle();
  if (!profilo || !["admin", "responsabile"].includes(profilo.ruolo)) {
    redirect("/dashboard-operatore");
  }

  return { supabase, user: user!, profilo };
}

/** Richiede un utente con ruolo admin/responsabile/supervisore: usata dalle
 *  dashboard "Monitoraggio Assistenze" e "Monitoraggio Consegne", che il
 *  supervisore deve poter vedere (in sola lettura, filtrate sul suo brand
 *  tramite RLS - vedi 0013_ruolo_supervisore.sql) senza però poter entrare
 *  nel pannello /admin (quello resta riservato a richiediAdmin sopra). */
export async function richiediVisioneDirezione() {
  const supabase = creaSupabaseClientServer();
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;
  if (!user || error) {
    redirect("/login/operatore");
  }

  const { data: profilo } = await supabase.from("utenti").select("ruolo").eq("id", user!.id).maybeSingle();
  if (!profilo || !["admin", "responsabile", "supervisore"].includes(profilo.ruolo)) {
    redirect("/dashboard-operatore");
  }

  return { supabase, user: user!, profilo };
}
