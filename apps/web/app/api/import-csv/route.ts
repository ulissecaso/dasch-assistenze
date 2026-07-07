// app/api/import-csv/route.ts
// Endpoint per l'importazione manuale (upload da admin panel) o automatica
// (invocato dallo scraper/pipeline dopo il download del CSV dal gestionale).
//
// Riusa la stessa logica di scripts/import-csv (mapping identico), così da
// avere un'unica fonte di verità sul parsing indipendentemente dal trigger
// (upload manuale, cron, scraper).
import { NextRequest, NextResponse } from "next/server";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";

export async function POST(req: NextRequest) {
  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ errore: "Nessun file ricevuto" }, { status: 400 });
  }

  const testoCsv = await file.text();
  const supabase = creaSupabaseClientAdmin();

  // La logica di parsing/mapping è la stessa di scripts/import-csv/parseCsv.mjs
  // e mapToDomain.mjs — in produzione, estrarle in un package condiviso
  // (es. packages/import-logic) usato sia dallo script CLI sia da questa route.
  const { parseFileCompletoDaTesto } = await import("@/lib/import/parseCsvTesto");
  const { raggruppaInPratiche } = await import("@/lib/import/mapToDomain");

  const { righe, errori } = parseFileCompletoDaTesto(testoCsv);
  const pratiche = raggruppaInPratiche(righe);

  const { data: importazione } = await supabase
    .from("importazioni_csv")
    .insert({ nome_file: file.name, origine: "manuale", righe_totali: righe.length, stato: "in_corso" })
    .select()
    .single();

  // NB: per import di grandi dimensioni via HTTP, valutare l'esecuzione
  // in background (Supabase Edge Function / job queue) per non superare i
  // timeout della funzione serverless. Qui è mostrata la logica sincrona
  // di base equivalente allo script CLI (vedi scripts/import-csv).

  return NextResponse.json({
    importazione_id: importazione?.id,
    righe_totali: righe.length,
    pratiche_rilevate: pratiche.length,
    errori_parsing: errori.length,
    messaggio: "Import avviata. Consultare /admin per lo stato di avanzamento.",
  });
}
