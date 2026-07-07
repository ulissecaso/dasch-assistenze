// supabase/functions/check-sla/index.ts
// Edge Function (Deno) — motore di automazioni SLA/alert.
// Va invocata periodicamente (ogni 15-30 min) tramite Supabase Scheduled
// Functions (pg_cron + net.http_post) oppure da uno scheduler esterno
// (GitHub Actions cron, Vercel Cron) che chiama questo endpoint con la
// service role key.
//
// Logica (aggiornata con il modello a catena Primo/Secondo/Periodico+Escalation
// definito in 0004_alert_avanzati.sql):
//  1. legge le regole attive da `regole_alert`, filtrate per fase (v_pratiche_in_ritardo)
//  2. per ogni pratica in ritardo su quella fase, calcola se la soglia della regola
//     è stata superata
//  3. usa `alert_occorrenze` (una riga per regola+pratica) per sapere se/quante
//     volte quella regola è già stata inviata per quella pratica:
//       - regole "primo" / "secondo" / "escalation" (una tantum): inviate una sola
//         volta per pratica, mai ripetute
//       - regole "periodico": ripetute ogni `ripeti_ogni_valore`/`ripeti_ogni_unita`
//         finché non si raggiunge `ripeti_max_volte`; superato il tetto, si smette
//         di ripetere e si attiva (una tantum) `regola_escalation_id`
//  4. per ogni invio crea una notifica per ogni destinatario di ruolo configurato
//     più l'operatore assegnato alla pratica (sempre incluso)
//  5. gestisce separatamente le regole 'pratica_ferma_da' (safety net generico,
//     non legato a una fase specifica): dedupe fisso a 24h come in precedenza.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function convertiInOre(valore: number, unita: string): number {
  return unita === "giorni" ? valore * 24 : valore;
}

Deno.serve(async (_req) => {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const risultato = { alert_creati: 0, escalation_create: 0, errori: [] as string[] };

  try {
    const { data: regole, error: erroreRegole } = await supabase
      .from("regole_alert")
      .select("*")
      .eq("attiva", true);
    if (erroreRegole) throw erroreRegole;

    for (const regola of regole ?? []) {
      if (regola.tipo_condizione === "fase_non_iniziata_entro" || regola.tipo_condizione === "fase_non_completata_entro") {
        if (!regola.fase_id) continue;

        const { data: ritardi, error } = await supabase
          .from("v_pratiche_in_ritardo")
          .select("*")
          .eq("fase_id", regola.fase_id);
        if (error) { risultato.errori.push(`${regola.nome}: ${error.message}`); continue; }

        for (const riga of ritardi ?? []) {
          const sogliaOre = convertiInOre(regola.soglia_valore, regola.soglia_unita);
          if (riga.ore_di_ritardo < sogliaOre) continue;

          await gestisciRegolaFase(supabase, regola, riga, risultato);
        }
      }

      if (regola.tipo_condizione === "pratica_ferma_da") {
        const sogliaOre = convertiInOre(regola.soglia_valore, regola.soglia_unita);
        const { data: pratiche, error } = await supabase
          .from("pratiche")
          .select("id, codice_commissione, operatore_assegnato_id, updated_at")
          .not("stato_generale", "in", '("chiusa","annullata")')
          .lt("updated_at", new Date(Date.now() - sogliaOre * 3600 * 1000).toISOString());
        if (error) { risultato.errori.push(`${regola.nome}: ${error.message}`); continue; }

        for (const pratica of pratiche ?? []) {
          const destinatari = await risolviDestinatari(supabase, regola.destinatari_ruolo, pratica.operatore_assegnato_id);
          for (const utenteId of destinatari) {
            const giaNotificato = await esisteNotificaRecente(supabase, utenteId, pratica.id, regola.id, 24);
            if (giaNotificato) continue;
            await supabase.from("notifiche").insert({
              utente_id: utenteId,
              pratica_id: pratica.id,
              regola_alert_id: regola.id,
              tipo: "escalation",
              titolo: regola.nome,
              messaggio: `Pratica ${pratica.codice_commissione} ferma da oltre ${regola.soglia_valore} ${regola.soglia_unita}.`,
              canale: "app",
            });
            risultato.escalation_create++;
          }
        }
      }
    }

    return new Response(JSON.stringify(risultato), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    return new Response(JSON.stringify({ errore: String(err) }), { status: 500 });
  }
});

// ---------------------------------------------------------------------
// Gestisce una singola regola "a catena" (primo/secondo/periodico/escalation)
// per una singola pratica in ritardo, usando alert_occorrenze come stato.
// ---------------------------------------------------------------------
async function gestisciRegolaFase(supabase: any, regola: any, riga: any, risultato: any) {
  const occorrenza = await leggiOCreaOccorrenza(supabase, regola.id, riga.pratica_id);

  const isPeriodica = regola.ripeti_ogni_valore != null && regola.ripeti_ogni_unita != null;

  if (isPeriodica) {
    if (regola.ripeti_max_volte != null && occorrenza.volte_inviato >= regola.ripeti_max_volte) {
      // Tetto di ripetizioni raggiunto: attiva l'escalation associata, una tantum.
      if (regola.regola_escalation_id && !occorrenza.escalation_attivata) {
        const { data: regolaEscalation } = await supabase
          .from("regole_alert")
          .select("*")
          .eq("id", regola.regola_escalation_id)
          .maybeSingle();
        if (regolaEscalation) {
          await inviaNotificaATutti(supabase, regolaEscalation, riga, "escalation", risultato, true);
        }
        await supabase.from("alert_occorrenze").update({ escalation_attivata: true }).eq("id", occorrenza.id);
      }
      return;
    }

    const intervalOre = convertiInOre(regola.ripeti_ogni_valore, regola.ripeti_ogni_unita);
    const ultimoInvio = occorrenza.ultimo_invio ? new Date(occorrenza.ultimo_invio).getTime() : null;
    const dovutoInviare = ultimoInvio === null || (Date.now() - ultimoInvio) >= intervalOre * 3600 * 1000;
    if (!dovutoInviare) return;

    await inviaNotificaATutti(supabase, regola, riga, "alert_sla", risultato, false);
    await supabase.from("alert_occorrenze").update({
      volte_inviato: occorrenza.volte_inviato + 1,
      ultimo_invio: new Date().toISOString(),
    }).eq("id", occorrenza.id);
  } else {
    // primo / secondo / escalation dirette: una tantum per pratica
    if (occorrenza.volte_inviato > 0) return;
    await inviaNotificaATutti(supabase, regola, riga, regola.livello === "escalation" ? "escalation" : "alert_sla", risultato, regola.livello === "escalation");
    await supabase.from("alert_occorrenze").update({
      volte_inviato: 1,
      ultimo_invio: new Date().toISOString(),
    }).eq("id", occorrenza.id);
  }
}

async function inviaNotificaATutti(supabase: any, regola: any, riga: any, tipo: string, risultato: any, contaComeEscalation: boolean) {
  const destinatari = await risolviDestinatari(supabase, regola.destinatari_ruolo, riga.operatore_assegnato_id);
  for (const utenteId of destinatari) {
    await supabase.from("notifiche").insert({
      utente_id: utenteId,
      pratica_id: riga.pratica_id,
      regola_alert_id: regola.id,
      tipo,
      titolo: regola.nome,
      messaggio: `Pratica ${riga.codice_commissione}: fase "${riga.fase_nome}" in ritardo di ${Math.round(riga.ore_di_ritardo)} ore.`,
      canale: "app",
    });
  }
  if (contaComeEscalation) risultato.escalation_create += destinatari.length;
  else risultato.alert_creati += destinatari.length;
}

async function leggiOCreaOccorrenza(supabase: any, regolaId: string, praticaId: string) {
  const { data: esistente } = await supabase
    .from("alert_occorrenze")
    .select("*")
    .eq("regola_alert_id", regolaId)
    .eq("pratica_id", praticaId)
    .maybeSingle();
  if (esistente) return esistente;

  const { data: nuova, error } = await supabase
    .from("alert_occorrenze")
    .insert({ regola_alert_id: regolaId, pratica_id: praticaId })
    .select()
    .single();
  if (error) {
    // race condition (due invocazioni concorrenti): rileggi
    const { data: riletta } = await supabase
      .from("alert_occorrenze")
      .select("*")
      .eq("regola_alert_id", regolaId)
      .eq("pratica_id", praticaId)
      .single();
    return riletta;
  }
  return nuova;
}

async function risolviDestinatari(supabase: any, ruoli: string[], operatoreAssegnatoId: string | null) {
  const ids = new Set<string>();
  if (operatoreAssegnatoId) ids.add(operatoreAssegnatoId);
  if (ruoli && ruoli.length > 0) {
    const { data: utenti } = await supabase.from("utenti").select("id").in("ruolo", ruoli).eq("attivo", true);
    for (const u of utenti ?? []) ids.add(u.id);
  }
  return [...ids];
}

async function esisteNotificaRecente(supabase: any, utenteId: string, praticaId: string, regolaId: string, oreFinestra: number) {
  const { data } = await supabase
    .from("notifiche")
    .select("id")
    .eq("utente_id", utenteId)
    .eq("pratica_id", praticaId)
    .eq("regola_alert_id", regolaId)
    .gt("created_at", new Date(Date.now() - oreFinestra * 3600 * 1000).toISOString())
    .maybeSingle();
  return !!data;
}
