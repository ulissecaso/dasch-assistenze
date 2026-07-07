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
          cookieStore.set({ name, value, ...options });
        },
        remove(name: string, options: any) {
          cookieStore.set({ name, value: "", ...options });
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
