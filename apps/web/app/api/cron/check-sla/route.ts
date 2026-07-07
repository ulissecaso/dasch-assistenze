// app/api/cron/check-sla/route.ts
// Alternativa a supabase/functions/check-sla se si preferisce eseguire il
// motore SLA come Vercel Cron Job invece che come Supabase Edge Function.
// Configurare in vercel.json:
//   { "crons": [{ "path": "/api/cron/check-sla", "schedule": "*/15 * * * *" }] }
import { NextResponse } from "next/server";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

export async function GET(req: Request) {
  // protezione minima: Vercel Cron invia un header "Authorization: Bearer <CRON_SECRET>"
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ errore: "non autorizzato" }, { status: 401 });
  }

  const supabase = creaSupabaseClientAdmin();
  const { data: ritardi } = await supabase.from("v_pratiche_in_ritardo").select("*");

  // Logica di dettaglio identica a supabase/functions/check-sla/index.ts:
  // qui riportata solo la struttura, per evitare duplicazione mantenere
  // la logica in un modulo condiviso lib/automazioni/checkSla.ts.
  return NextResponse.json({ verificate: ritardi?.length ?? 0 });
}
