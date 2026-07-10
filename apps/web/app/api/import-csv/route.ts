// app/api/import-csv/route.ts
// Endpoint per l'importazione manuale (upload da admin panel) o automatica
// (invocato dallo scraper/pipeline dopo il download del CSV dal gestionale).
//
// Riusa la stessa logica di scripts/import-csv (mapping identico) tramite
// lib/import/eseguiImportazione.ts, così da avere un'unica fonte di verità
// sul parsing e sulla scrittura, indipendentemente dal trigger (upload
// manuale, cron, scraper).
import { NextRequest, NextResponse } from "next/server";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import { richiediAdmin } from "@/lib/auth/richiediUtente";
import { eseguiImportazioneCsv } from "@/lib/import/eseguiImportazione";

// Alza il tempo massimo concesso a questa funzione (default troppo basso
// per file con molte righe, anche dopo l'ottimizzazione a query "in blocco"
// di eseguiImportazione.ts). 60s è il massimo configurabile sui piani
// Vercel Hobby/Pro senza Fluid Compute; se il piano non lo consente questo
// valore viene semplicemente ignorato, senza errori.
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  // Solo admin/responsabile possono avviare un'importazione da qui (stessa
  // regola della pagina /admin che ospita il form di upload).
  await richiediAdmin();

  const formData = await req.formData();
  const file = formData.get("file") as File | null;
  if (!file) {
    return NextResponse.json({ errore: "Nessun file ricevuto" }, { status: 400 });
  }

  const testoCsv = await file.text();
  const supabase = creaSupabaseClientAdmin();

  try {
    const risultato = await eseguiImportazioneCsv(supabase, testoCsv, {
      nomeFile: file.name,
      origine: "manuale",
    });

    return NextResponse.json({
      importazione_id: risultato.importazioneId,
      righe_totali: risultato.righeTotali,
      pratiche_rilevate: risultato.praticheRilevate,
      pratiche_aggiornate: risultato.praticheAggiornate,
      pratiche_invariate: risultato.praticheInvariate,
      pratiche_ignorate: risultato.praticheIgnorate,
      nuove_consegne: risultato.nuoveConsegne,
      righe_nuove: risultato.nuoveRighe,
      errori: risultato.righeErrore + risultato.erroriParsing,
      stato: risultato.stato,
      messaggio: "Importazione completata.",
    });
  } catch (err: any) {
    return NextResponse.json({ errore: String(err?.message || err) }, { status: 500 });
  }
}
