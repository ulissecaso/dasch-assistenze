// app/api/cron/importa-email/route.ts
// Cron job (Vercel, vedi vercel.json) che legge periodicamente la casella
// IMAP delle segnalazioni assistenza (OVH), interpreta ogni messaggio nuovo
// con lib/email/parserSegnalazione e crea/aggiorna le pratiche tramite
// lib/email/elaboraSegnalazione. Idempotente: ogni messaggio viene
// identificato dal suo Message-ID, salvato in importazioni_email, così ri-
// eseguire il job non genera doppioni.
//
// MULTI-BRAND: ogni brand puo' avere una propria casella IMAP. Il brand da
// leggere si passa come querystring (?brand=CODICE) nel path configurato in
// vercel.json - un cron entry per brand, stessa route. Se omesso, default
// CINQUEGRANA (comportamento storico, invariato).
//
// Variabili d'ambiente richieste (da impostare su Vercel):
//   Cinquegrana (nomi storici, INVARIATI): IMAP_HOST, IMAP_PORT, IMAP_USER, IMAP_PASSWORD
//   Qualsiasi altro brand: stesso nome con suffisso _<CODICE_BRAND>, es. per
//     FEBAL: IMAP_HOST_FEBAL, IMAP_PORT_FEBAL, IMAP_USER_FEBAL, IMAP_PASSWORD_FEBAL
//   Comune a tutti i brand: CRON_SECRET
//
// ATTENZIONE: il parser (lib/email/parserSegnalazione.ts) oggi riconosce solo
// i due formati di Cinquegrana ("app" e "sito" Gravity Forms). Un nuovo brand
// con un template email diverso andra' quasi certamente in esito 'errore'
// finche' non si aggiunge un terzo ramo "formato" basato su un'email vera
// ricevuta da quella casella (stesso lavoro fatto per il bug del formato
// "sito" di Cinquegrana).
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

  const { searchParams } = new URL(req.url);
  const brandCodice = (searchParams.get("brand") ?? BRAND_CODICE_DEFAULT).toUpperCase();
  // Cinquegrana mantiene i nomi storici delle variabili (nessuna migrazione
  // di configurazione necessaria); ogni altro brand usa lo stesso nome con
  // suffisso _<CODICE>.
  const suffisso = brandCodice === BRAND_CODICE_DEFAULT ? "" : `_${brandCodice}`;
  const host = process.env[`IMAP_HOST${suffisso}`];
  const port = Number(process.env[`IMAP_PORT${suffisso}`] ?? 993);
  const user = process.env[`IMAP_USER${suffisso}`];
  const password = process.env[`IMAP_PASSWORD${suffisso}`];
  if (!host || !user || !password) {
    return NextResponse.json({ errore: `variabili IMAP non configurate per il brand '${brandCodice}' (attese IMAP_HOST${suffisso}/IMAP_USER${suffisso}/IMAP_PASSWORD${suffisso})` }, { status: 500 });
  }

  const supabase = creaSupabaseClientAdmin();

  const { data: brand, error: erroreBrand } = await supabase
    .from("brands")
    .select("id")
    .eq("codice", brandCodice)
    .maybeSingle();
  if (erroreBrand || !brand) {
    return NextResponse.json({ errore: `brand '${brandCodice}' non trovato (migrazione 0011 applicata?)` }, { status: 500 });
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
