// app/api/cron/importa-email/route.ts
// Cron job (Vercel, vedi vercel.json) che legge periodicamente la casella
// IMAP delle segnalazioni assistenza (OVH), interpreta ogni messaggio nuovo
// con lib/email/parserSegnalazione e crea/aggiorna le pratiche tramite
// lib/email/elaboraSegnalazione. Idempotente: ogni messaggio viene
// identificato dal suo Message-ID, salvato in importazioni_email, così ri-
// eseguire il job non genera doppioni.
//
// Variabili d'ambiente richieste (da impostare su Vercel):
//   IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD, CRON_SECRET
//
// MULTI-BRAND — PUNTO APERTO: questo cron legge UNA SOLA casella IMAP, oggi
// quella di Cinquegrana (servizioclienti@arredamenticinquegrana.it). Tutte
// le segnalazioni ricevute vengono quindi etichettate come Cinquegrana (vedi
// BRAND_CODICE_DEFAULT sotto). Se Master Mobili avra' una propria casella di
// segnalazioni, le opzioni sono: (a) una seconda variabile IMAP_*_MASTERMOBILI
// e un secondo cron separato che chiama questa stessa logica con l'altro
// brandId, oppure (b) se useranno la STESSA casella, riconoscere il brand dal
// destinatario del messaggio (envelope.to) invece che da una casella dedicata.
// Nessuna delle due e' stata implementata qui: serve sapere come Master
// Mobili riceve le segnalazioni prima di scegliere.
const BRAND_CODICE_DEFAULT = "CINQUEGRANA";
import { NextResponse } from "next/server";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { creaSupabaseClientAdmin } from "@/lib/supabase/server";
import { analizzaSegnalazione } from "@/lib/email/parserSegnalazione";
import { elaboraSegnalazione } from "@/lib/email/elaboraSegnalazione";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Quanti giorni indietro guardare ad ogni esecuzione: una finestra ampia più
// del solito costa poco (l'idempotenza su message_id scarta i già visti) ed
// evita di perdere messaggi se il cron salta un'esecuzione.
const GIORNI_FINESTRA = 3;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ errore: "non autorizzato" }, { status: 401 });
  }

  const host = process.env.IMAP_HOST;
  const port = Number(process.env.IMAP_PORT ?? 993);
  const user = process.env.IMAP_USER;
  const password = process.env.IMAP_PASSWORD;
  if (!host || !user || !password) {
    return NextResponse.json({ errore: "variabili IMAP non configurate" }, { status: 500 });
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: brand, error: erroreBrand } = await supabase
    .from("brands")
    .select("id")
    .eq("codice", BRAND_CODICE_DEFAULT)
    .maybeSingle();
  if (erroreBrand || !brand) {
    return NextResponse.json({ errore: `brand '${BRAND_CODICE_DEFAULT}' non trovato (migrazione 0011 applicata?)` }, { status: 500 });
  }
  const brandId = brand.id as string;

  const client = new ImapFlow({
    host,
    port,
    secure: true,
    auth: { user, pass: password },
    logger: false,
  });

  const risultato = { esaminati: 0, creati: 0, aggiornati: 0, ignorati: 0, errori: 0 };

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const da = new Date();
      da.setDate(da.getDate() - GIORNI_FINESTRA);

      for await (const messaggio of client.fetch(
        { since: da },
        { envelope: true, source: true }
      )) {
        risultato.esaminati++;
        const messageId = messaggio.envelope?.messageId ?? `uid-${messaggio.uid}`;

        // Idempotenza: se questo message_id è già stato registrato, salta.
        const { data: giaProcessato } = await supabase
          .from("importazioni_email")
          .select("id")
          .eq("message_id", messageId)
          .maybeSingle();
        if (giaProcessato) continue;

        try {
          const parsed = await simpleParser(messaggio.source as Buffer);
          const oggetto = parsed.subject ?? "";
          const corpo = parsed.text ?? "";
          const mittente = parsed.from?.text ?? "";

          const dati = analizzaSegnalazione(oggetto, corpo);
          const esito = await elaboraSegnalazione(supabase, dati, brandId);

          await supabase.from("importazioni_email").insert({
            message_id: messageId,
            mittente,
            oggetto,
            ricevuta_il: parsed.date ? parsed.date.toISOString() : null,
            formato_rilevato: dati.formato,
            esito: esito.esito,
            pratica_id: esito.praticaId,
            messaggio_errore: esito.messaggioErrore ?? null,
            dati_estratti: dati,
            corpo_grezzo: corpo.slice(0, 10000),
          });

          if (esito.esito === "creata") risultato.creati++;
          else if (esito.esito === "aggiornata") risultato.aggiornati++;
          else if (esito.esito === "ignorata") risultato.ignorati++;
          else risultato.errori++;
        } catch (erroreMessaggio: any) {
          risultato.errori++;
          await supabase.from("importazioni_email").insert({
            message_id: messageId,
            mittente: messaggio.envelope?.from?.[0]?.address ?? null,
            oggetto: messaggio.envelope?.subject ?? null,
            formato_rilevato: "sconosciuto",
            esito: "errore",
            messaggio_errore: String(erroreMessaggio?.message ?? erroreMessaggio),
          });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return NextResponse.json(risultato);
}
