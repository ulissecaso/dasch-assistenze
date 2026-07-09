// lib/email/elaboraSegnalazione.ts
// Logica di dominio: dato un messaggio già interpretato (SegnalazioneEstratta),
// trova o crea il cliente e la pratica corrispondente. Chiamata sia dal cron
// IMAP (app/api/cron/importa-email) sia, potenzialmente in futuro, da un
// endpoint webhook diretto se il sito/app inizieranno a chiamare un'API
// invece di mandare email (questo modulo non sa nulla di email/IMAP, lavora
// solo su dati già estratti — è la parte che sopravvive al cambio di fonte).
import type { SegnalazioneEstratta } from "./parserSegnalazione";

export interface EsitoElaborazione {
  esito: "creata" | "aggiornata" | "ignorata" | "errore";
  praticaId: string | null;
  messaggioErrore?: string;
}

// Genera il prossimo suffisso per una commissione con interventi precedenti
// tutti chiusi: il primo intervento non ha suffisso, il secondo è "-B", il
// terzo "-C", ecc. (indice 0 → nessun suffisso, già coperto dal chiamante).
function suffissoIntervento(numeroInterventiPrecedenti: number): string {
  const lettera = String.fromCharCode(65 + numeroInterventiPrecedenti); // 1 -> B, 2 -> C, ...
  return lettera;
}

async function trovaOCreaCliente(supabase: any, dati: SegnalazioneEstratta) {
  if (dati.email) {
    const { data } = await supabase.from("clienti").select("*").ilike("email", dati.email).limit(1).maybeSingle();
    if (data) return await arricchisciCliente(supabase, data, dati);
  }
  if (dati.telefono) {
    const { data } = await supabase.from("clienti").select("*").eq("telefono", dati.telefono).limit(1).maybeSingle();
    if (data) return await arricchisciCliente(supabase, data, dati);
  }
  if (dati.nome) {
    const { data } = await supabase.from("clienti").select("*").ilike("nome_completo", dati.nome).limit(1).maybeSingle();
    if (data) return await arricchisciCliente(supabase, data, dati);
  }

  const { data: nuovo, error } = await supabase
    .from("clienti")
    .insert({
      nome_completo: dati.nome ?? "Cliente da verificare",
      telefono: dati.telefono,
      email: dati.email,
      note: "Creato automaticamente da segnalazione email",
    })
    .select()
    .single();
  if (error) throw error;
  return nuovo;
}

// Se il cliente esiste già ma mancano telefono/email, li completa con i dati
// di questa segnalazione senza mai sovrascrivere un valore già presente.
async function arricchisciCliente(supabase: any, cliente: any, dati: SegnalazioneEstratta) {
  const aggiornamenti: Record<string, string> = {};
  if (!cliente.telefono && dati.telefono) aggiornamenti.telefono = dati.telefono;
  if (!cliente.email && dati.email) aggiornamenti.email = dati.email;
  if (Object.keys(aggiornamenti).length === 0) return cliente;

  const { data } = await supabase.from("clienti").update(aggiornamenti).eq("id", cliente.id).select().single();
  return data ?? cliente;
}

export async function elaboraSegnalazione(
  supabase: any,
  dati: SegnalazioneEstratta
): Promise<EsitoElaborazione> {
  if (dati.formato === "sconosciuto" || !dati.commissione || !dati.nome) {
    return {
      esito: "errore",
      praticaId: null,
      messaggioErrore: !dati.commissione
        ? "Numero di commissione non trovato nel messaggio"
        : !dati.nome
        ? "Nome cliente non trovato nel messaggio"
        : "Formato email non riconosciuto",
    };
  }

  const cliente = await trovaOCreaCliente(supabase, dati);

  const { data: praticheEsistenti, error: erroreLookup } = await supabase
    .from("pratiche")
    .select("id, codice_commissione, stato_generale")
    .eq("codice_commissione_riferimento", dati.commissione)
    .order("created_at", { ascending: false });
  if (erroreLookup) throw erroreLookup;

  const praticaAttiva = (praticheEsistenti ?? []).find(
    (p: any) => !["chiusa", "annullata"].includes(p.stato_generale)
  );

  if (praticaAttiva) {
    // Non duplicare: la commissione ha già una pratica in corso. Aggiungiamo
    // traccia della nuova segnalazione sulla fase di ricezione (nota) e nello
    // storico, senza toccare stato/assegnazione già in corso.
    const { data: faseRicezione } = await supabase
      .from("pratica_fasi")
      .select("id, note, fasi_workflow!inner(codice)")
      .eq("pratica_id", praticaAttiva.id)
      .eq("fasi_workflow.codice", "ricezione")
      .maybeSingle();

    const notaAggiuntiva = `[${new Date().toLocaleString("it-IT")}] Nuova segnalazione ricevuta (${dati.formato}): ${dati.descrizione ?? "(nessuna descrizione)"}`;
    if (faseRicezione) {
      const noteUnite = faseRicezione.note ? `${faseRicezione.note}\n\n${notaAggiuntiva}` : notaAggiuntiva;
      await supabase.from("pratica_fasi").update({ note: noteUnite }).eq("id", faseRicezione.id);
    }

    await supabase.from("storico_modifiche").insert({
      entita: "pratiche",
      entita_id: praticaAttiva.id,
      campo: "segnalazione_email",
      valore_precedente: null,
      valore_nuovo: notaAggiuntiva,
      origine: "automazione",
    });

    return { esito: "aggiornata", praticaId: praticaAttiva.id };
  }

  // Nessuna pratica attiva per questa commissione: la creiamo. Se esistono
  // solo pratiche passate (tutte chiuse/annullate) per la stessa commissione,
  // usiamo un codice con suffisso per tenerle distinte.
  //
  // IMPORTANTE: dati.commissione è il numero che il CLIENTE ha scritto nella
  // mail come riferimento a un intervento precedente — NON è il codice della
  // nuova commissione di assistenza. Vamart assegnerà un numero nuovo e
  // diverso quando l'operatore la creerà (regola confermata dal Direttore).
  // Usiamo quindi un codice provvisorio "IN-ATTESA-..." finché
  // l'importatore da Vamart (importCommissioniAssistenza.mjs) non trova - per
  // nome cliente - la vera commissione e la ricollega. Non usare mai
  // dati.commissione come codice_commissione: è già un numero Vamart
  // esistente (di solito già chiuso), riusarlo creerebbe confusione con la
  // pratica storica e rischio di importare dati sbagliati dal Piano di Carico.
  const numeroPrecedenti = praticheEsistenti?.length ?? 0;
  const riferimentoSicuro = dati.commissione.replace(/\//g, "-");
  const codiceCommissione =
    numeroPrecedenti === 0
      ? `IN-ATTESA-${riferimentoSicuro}`
      : `IN-ATTESA-${riferimentoSicuro}-${suffissoIntervento(numeroPrecedenti)}`;

  const { data: nuovaPratica, error: erroreInsert } = await supabase
    .from("pratiche")
    .insert({
      codice_commissione: codiceCommissione,
      codice_commissione_riferimento: dati.commissione,
      cliente_id: cliente.id,
      tipo: dati.tipoProblema,
      descrizione: dati.descrizione,
      canale_origine: "email",
      fonte_dati: "api",
      stato_generale: "aperta",
    })
    .select()
    .single();
  if (erroreInsert) throw erroreInsert;

  // I trigger di DB (0002_automazioni.sql) hanno già assegnato l'operatore e
  // creato tutte le righe pratica_fasi con la prima fase (ordine minimo,
  // "Ricezione segnalazione") in_corso. Dato che questa pratica nasce PROPRIO
  // dalla ricezione della mail, marchiamo quella fase come già completata e
  // facciamo avanzare il puntatore alla fase successiva ("Presa in carico").
  const { data: fasi } = await supabase
    .from("pratica_fasi")
    .select("id, note, fasi_workflow!inner(codice, ordine)")
    .eq("pratica_id", nuovaPratica.id);

  const faseRicezione = (fasi ?? []).find((f: any) => f.fasi_workflow.codice === "ricezione");
  const fasePresaInCarico = (fasi ?? []).find((f: any) => f.fasi_workflow.codice === "presa_in_carico");

  if (faseRicezione) {
    await supabase
      .from("pratica_fasi")
      .update({
        stato: "completata",
        data_effettiva: new Date().toISOString(),
        note: `Segnalazione ricevuta automaticamente via email (${dati.formato}).`,
      })
      .eq("id", faseRicezione.id);
  }
  if (fasePresaInCarico) {
    await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", fasePresaInCarico.id);
  }

  return { esito: "creata", praticaId: nuovaPratica.id };
}
