// app/api/import-csv-commissioni/route.ts
// Endpoint per l'importazione manuale (upload da admin panel) del CSV
// "Commissioni" di Vamart (filtro "Solo di assistenza"): stessa logica usata
// dallo scraper automatico (scripts/import-csv/importCommissioniAssistenza.mjs),
// vedi lib/import/eseguiImportazioneCommissioni.ts per il porting TypeScript.
import { NextRequest, NextResponse } from "next/server";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import { eseguiImportazioneCommissioniCsv } from "@/lib/import/eseguiImportazioneCommissioni";

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  await richiediAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ errore: "Nessun file ricevuto" }, { status: 400 });
  }
  const brandCodice = (formData.get("brand") as string | null) || "CINQUEGRANA";

  const testoCsv = await file.text();
  const supabase = creaSupabaseClientAdmin();

  try {
    const risultato = await eseguiImportazioneCommissioniCsv(supabase, testoCsv, {
      nomeFile: file.name,
      brandCodice,
    });

    return NextResponse.json({
      importazione_id: risultato.importazioneId,
      righe_totali: risultato.righeTotali,
      nuove: risultato.nuove,
      ricollegate: risultato.ricollegate,
      riclassificate: risultato.riclassificate,
      gia_presenti: risultato.giaPresenti,
      escluse: risultato.escluse,
      errori: risultato.errori,
      stato: risultato.stato,
      messaggio: "Importazione completata.",
    });
  } catch (err: any) {
    return NextResponse.json({ errore: String(err?.message || err) }, { status: 500 });
  }
}
