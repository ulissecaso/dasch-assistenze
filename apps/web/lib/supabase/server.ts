// lib/supabase/server.ts
// Client Supabase lato server (Server Components, Route Handlers).
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export function creaSupabaseClientServer() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return cookieStore.get(name)?.value;
        },
        set(name: string, value: string, options: any) {
          // In un Server Component (rendering di sola lettura) cookies()
          // non permette la scrittura: qui capita quando Supabase prova a
          // rinfrescare il token durante il rendering della pagina. Il
          // middleware.ts si occupa già di rinfrescare e persistere il
          // cookie ad ogni richiesta, quindi qui l'errore è atteso e va
          // ignorato in sicurezza (pattern raccomandato da Supabase).
          try {
            cookieStore.set({ name, value, ...options });
          } catch {
            // no-op: siamo in un Server Component, il middleware gestisce già i cookie
          }
        },
        remove(name: string, options: any) {
          try {
            cookieStore.set({ name, value: "", ...options });
          } catch {
            // no-op: siamo in un Server Component, il middleware gestisce già i cookie
          }
        },
      },
    }
  );
}

/** Client con service role key: SOLO in Route Handler/server, mai esposto al browser. */
export function creaSupabaseClientAdmin() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
}
