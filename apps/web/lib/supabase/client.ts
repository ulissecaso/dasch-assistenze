// lib/supabase/client.ts
// Client Supabase lato browser (componenti "use client").
import { createBrowserClient } from "@supabase/ssr";

export function creaSupabaseClientBrowser() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  );
}
