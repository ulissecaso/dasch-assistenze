// app/api/monitor/dettaglio-metrica/route.ts
// Alimenta il modal "vedi le pratiche" che si apre cliccando una delle 5
// card statistiche in fondo al Monitor (ALLERT TOTALI, SCADUTI, IN SCADENZA
// OGGI, RISOLTI OGGI, PRATICHE TOTALI) — vedi MonitorBoard.tsx.
//
// Riservato alle dashboard autenticate (Direzione/Operatore): il monitor
// pubblico a parete (/monitor/direzione, /monitor/consegne) non deve avere
// nessun link verso il resto del portale, quindi lì le card non sono
// cliccabili (vedi prop righeCliccabili in MonitorBoard) e questo endpoint
// non viene mai chiamato da quello schermo.
import { NextRequest, NextResponse } from "next/server";
import { richiediVisioneDirezione } from "@/lib/auth/richiediUtente";
import { caricaDettaglioMetricaMonitor, type MetricaMonitor } from "@/lib/monitor/caricaDettaglioMetrica";

const METRICHE_VALIDE: MetricaMonitor[] = ["allertTotali", "scaduti", "inScadenzaOggi", "risoltiOggi", "praticheTotali"];

export async function GET(req: NextRequest) {
  const { supabase } = await richiediVisioneDirezione();

  const metrica = req.nextUrl.searchParams.get("metrica") as MetricaMonitor | null;
  if (!metrica || !METRICHE_VALIDE.includes(metrica)) {
    return NextResponse.json({ errore: "Parametro 'metrica' mancante o non valido." }, { status: 400 });
  }

  const righe = await caricaDettaglioMetricaMonitor(supabase, metrica);
  return NextResponse.json({ righe });
}
