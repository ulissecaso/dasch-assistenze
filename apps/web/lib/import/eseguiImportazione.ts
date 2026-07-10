// lib/import/eseguiImportazione.ts
// Logica di scrittura condivisa dell'importazione "Piano di Carico" Vamart.
//
// STORIA (2 tentativi prima di questa versione):
//  1. La prima versione rifaceva, riga per riga, fino a 4 domande al
//     database. Su un file con migliaia di righe = migliaia di andirivieni
//     in un'unica richiesta HTTP: timeout su Vercel, nessuna riga salvata.
//  2. La seconda versione ha eliminato le query per-riga caricando in
//     anticipo tutto cio' che serve con query "in blocco" (batch) — ma le
//     eseguiva comunque UNA ALLA VOLTA, in sequenza (un blocco alla volta,
//     una pratica alla volta): con un Piano di Carico che contiene TUTTE le
//     commissioni Vamart (non solo assistenza, quindi potenzialmente
//     migliaia di codici), la sola somma dei tempi di rete di tante
//     richieste sequenziali bastava di nuovo a superare il timeout.
//
// Questa versione esegue le query in blocco IN PARALLELO (Promise.all)
// invece che in sequenza, e processa le pratiche con piu' operai
// concorrenti invece che una alla volta (vedi eseguiConConcorrenza): il
// tempo totale diventa quello del blocco piu' lento, non la somma di tutti.
import { parseFileCompletoDaTesto } from "./parseCsvTesto";
import { raggruppaInPratiche } from "./mapToDomain";

const FASI_NECESSARIE = [
  "ricezione",
  "presa_in_carico",
  "apertura_pratica",
  "creazione_commissione",
  "ordine_ricambi",
  "conferma_ordine",
  "arrivo_merce",
  "consegna_materiale",
] as const;

const STATI_ORDINATO_O_OLTRE = new Set(["Ordinato", "In giacenza", "Parzialmente consegnato", "Consegnato"]);
const STATI_ARRIVATO_O_OLTRE = new Set(["In giacenza", "Parzialmente consegnato", "Consegnato"]);

// Le query con .in(...) hanno un limite pratico di lunghezza (URL/parametri):
// spezziamo le liste lunghe in blocchi di questa dimensione. I blocchi
// vengono poi lanciati tutti insieme (Promise.all), non uno alla volta.
const DIMENSIONE_BLOCCO = 300;

// Quante pratiche processare in parallelo nella FASE 2 (confronto CSV vs
// database + scritture puntuali per fase). Un numero troppo alto rischia di
// saturare le connessioni al database; questo valore e' un compromesso
// prudente tra velocita' e stabilita'.
const CONCORRENZA_PRATICHE = 20;

function inBlocchi<T>(lista: T[], dimensione = DIMENSIONE_BLOCCO): T[][] {
  const blocchi: T[][] = [];
  for (let i = 0; i < lista.length; i += dimensione) blocchi.push(lista.slice(i, i + dimensione));
  return blocchi;
}

/** Esegue `fn` su ogni elemento di `elementi`, con al massimo `concorrenza`
 *  chiamate in volo contemporaneamente (invece di farle tutte insieme, che
 *  rischierebbe di saturare le connessioni al database, o una alla volta,
 *  che sarebbe troppo lento). */
async function eseguiConConcorrenza<T>(elementi: T[], concorrenza: number, fn: (el: T, indice: number) => Promise<void>) {
  let prossimo = 0;
  async function operaio() {
    while (prossimo < elementi.length) {
      const i = prossimo++;
      await fn(elementi[i], i);
    }
  }
  const numeroOperai = Math.max(1, Math.min(concorrenza, elementi.length));
  await Promise.all(Array.from({ length: numeroOperai }, operaio));
}

export type RisultatoImportazione = {
  importazioneId: string;
  righeTotali: number;
  praticheRilevate: number;
  nuoveRighe: number;
  praticheAggiornate: number;
  praticheInvariate: number;
  praticheIgnorate: number;
  righeErrore: number;
  erroriParsing: number;
  stato: "completata" | "completata_con_errori";
};

/** Esegue l'importazione completa di un CSV "Piano di Carico" Vamart: parsing,
 *  upsert delle righe, avanzamento automatico delle fasi (con lo stesso
 *  blocco umano su "conferma_ordine" del CLI) e registrazione della sessione
 *  in importazioni_csv. `origine` distingue nei log da dove arriva l'import
 *  (upload manuale dal pannello vs un futuro trigger automatico). */
export async function eseguiImportazioneCsv(
  supabase: any,
  testoCsv: string,
  opzioni: { nomeFile: string; origine?: "manuale" | "scraper_automatico" | "api" }
): Promise<RisultatoImportazione> {
  const origine = opzioni.origine ?? "manuale";

  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", FASI_NECESSARIE as unknown as string[]);
  if (erroreFasi) throw erroreFasi;

  const fasiIds: Record<string, string> = Object.fromEntries((fasiWorkflow ?? []).map((f: any) => [f.codice, f.id]));
  for (const codice of FASI_NECESSARIE) {
    if (!fasiIds[codice]) {
      throw new Error(`Fase '${codice}' non trovata in fasi_workflow (migrazione 0009_conferma_ordine.sql applicata?)`);
    }
  }
  const tutteLeFasiRilevanti = Object.values(fasiIds);

  const { righe, errori: erroriParsing } = parseFileCompletoDaTesto(testoCsv);
  const pratiche = raggruppaInPratiche(righe);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: opzioni.nomeFile,
      origine,
      righe_totali: righe.length,
      stato: "in_corso",
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  // ------------------------------------------------------------------
  // FASE 1: pre-carico in blocco, IN PARALLELO, tutto cio' che serve per
  // confrontare il CSV con lo stato attuale.
  // ------------------------------------------------------------------

  // 1a. Pratiche esistenti (match per codice_commissione).
  const codiciCommissione = [...new Set(pratiche.map((p: any) => p.codice_commissione))];
  const mappaPraticheEsistenti = new Map<string, any>();
  await Promise.all(
    inBlocchi(codiciCommissione).map(async (blocco) => {
      const { data, error } = await supabase.from("pratiche").select("*").in("codice_commissione", blocco);
      if (error) throw error;
      for (const p of data ?? []) mappaPraticheEsistenti.set(p.codice_commissione, p);
    })
  );
  const idPraticheEsistenti = [...mappaPraticheEsistenti.values()].map((p) => p.id);

  // 1b. Righe gia' presenti per quelle pratiche (chiave: pratica+articolo+descrizione).
  const mappaRigheEsistenti = new Map<string, any>();
  await Promise.all(
    inBlocchi(idPraticheEsistenti).map(async (blocco) => {
      const { data, error } = await supabase
        .from("pratica_righe")
        .select("id, pratica_id, codice_articolo, descrizione, riga_hash, status_riga")
        .in("pratica_id", blocco);
      if (error) throw error;
      for (const r of data ?? []) mappaRigheEsistenti.set(`${r.pratica_id}|${r.codice_articolo}|${r.descrizione}`, r);
    })
  );

  // 1c. Fornitori: quelli gia' noti + creazione in blocco di quelli mancanti.
  const nomiFornitori = [...new Set(righe.map((r: any) => r.fornitore).filter(Boolean))] as string[];
  const mappaFornitori = new Map<string, string>();
  await Promise.all(
    inBlocchi(nomiFornitori).map(async (blocco) => {
      const { data, error } = await supabase.from("fornitori").select("id, ragione_sociale").in("ragione_sociale", blocco);
      if (error) throw error;
      for (const f of data ?? []) mappaFornitori.set(f.ragione_sociale, f.id);
    })
  );
  const fornitoriMancanti = nomiFornitori.filter((n) => !mappaFornitori.has(n));
  if (fornitoriMancanti.length > 0) {
    await Promise.all(
      inBlocchi(fornitoriMancanti, 500).map(async (blocco) => {
        const { data, error } = await supabase
          .from("fornitori")
          .insert(blocco.map((ragione_sociale) => ({ ragione_sociale })))
          .select("id, ragione_sociale");
        if (error) throw error;
        for (const f of data ?? []) mappaFornitori.set(f.ragione_sociale, f.id);
      })
    );
  }

  // 1d. Fasi attuali (pratica_fasi) per tutte le pratiche coinvolte, cosi'
  // completaFasiPregresse/sincronizzaFasiDaRighe non devono piu'
  // interrogare il database per ogni singola pratica.
  const mappaFasiPerPratica = new Map<string, Map<string, any>>();
  await Promise.all(
    inBlocchi(idPraticheEsistenti).map(async (blocco) => {
      const { data, error } = await supabase
        .from("pratica_fasi")
        .select("id, pratica_id, fase_id, stato")
        .in("pratica_id", blocco)
        .in("fase_id", tutteLeFasiRilevanti);
      if (error) throw error;
      for (const f of data ?? []) {
        if (!mappaFasiPerPratica.has(f.pratica_id)) mappaFasiPerPratica.set(f.pratica_id, new Map());
        mappaFasiPerPratica.get(f.pratica_id)!.set(f.fase_id, f);
      }
    })
  );

  // ------------------------------------------------------------------
  // FASE 2: confronto in memoria + scritture puntuali, con piu' pratiche
  // lavorate in parallelo (vedi eseguiConConcorrenza) invece che una alla
  // volta.
  // ------------------------------------------------------------------
  let nuoveRighe = 0;
  let praticheAggiornate = 0;
  let praticheInvariate = 0;
  let praticheIgnorate = 0;
  let righeErrore = 0;

  const righeDaInserire: any[] = [];
  const aggiornamentiRiga: { id: string; payload: any; statoPrecedente: string | null; statoNuovo: string | null }[] = [];
  const storicoPraticheDaInserire: any[] = [];
  const erroriPratiche: { messaggio: string; dato: any }[] = [];

  await eseguiConConcorrenza(pratiche, CONCORRENZA_PRATICHE, async (pratica: any) => {
    try {
      const praticaEsistente = mappaPraticheEsistenti.get(pratica.codice_commissione);

      // Il Piano di Carico contiene TUTTE le commissioni Vamart (anche
      // vendite normali): se non esiste gia' una pratica di assistenza con
      // questo codice, la riga non riguarda l'assistenza e va ignorata.
      if (!praticaEsistente) {
        praticheIgnorate++;
        return;
      }

      const praticaId = praticaEsistente.id;
      if (praticaEsistente.stato_generale !== pratica.stato_generale) {
        await supabase.from("pratiche").update({ stato_generale: pratica.stato_generale }).eq("id", praticaId);
        storicoPraticheDaInserire.push({
          entita: "pratica",
          entita_id: praticaId,
          campo: "stato_generale",
          valore_precedente: praticaEsistente.stato_generale,
          valore_nuovo: pratica.stato_generale,
          origine: "importazione_csv",
        });
        praticheAggiornate++;
      } else {
        praticheInvariate++;
      }

      for (const riga of pratica.righe) {
        const fornitoreId = riga.fornitore ? mappaFornitori.get(riga.fornitore) ?? null : null;
        const chiave = `${praticaId}|${riga.codice_articolo}|${riga.descrizione}`;
        const rigaEsistente = mappaRigheEsistenti.get(chiave);

        const payloadRiga = {
          pratica_id: praticaId,
          fornitore_id: fornitoreId,
          codice_articolo: riga.codice_articolo,
          descrizione: riga.descrizione,
          quantita_venduta: riga.quantita_venduta,
          listino: riga.listino,
          quantita_ordinata: riga.quantita_ordinata,
          data_ordine: riga.data_ordine,
          conferma_ordine: riga.conferma_ordine,
          rif_conferma: riga.rif_conferma,
          pag_azienda: riga.pag_azienda,
          data_consegna_prevista: riga.data_consegna_prevista,
          quantita_giacente: riga.quantita_giacente,
          data_carico: riga.data_carico,
          quantita_consegnata: riga.quantita_consegnata,
          data_consegna: riga.data_consegna,
          status_riga: riga.status,
          magazzino: riga.magazzino,
          ubicazione: riga.ubicazione,
          riga_hash: riga.riga_hash,
        };

        if (!rigaEsistente) {
          righeDaInserire.push(payloadRiga);
          nuoveRighe++;
        } else if (rigaEsistente.riga_hash !== riga.riga_hash) {
          aggiornamentiRiga.push({
            id: rigaEsistente.id,
            payload: payloadRiga,
            statoPrecedente: rigaEsistente.status_riga,
            statoNuovo: riga.status,
          });
        }
      }

      const fasiDiQuestaPratica = mappaFasiPerPratica.get(praticaId) ?? new Map();
      await completaFasiPregresse(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica);
      await sincronizzaFasiDaRighe(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica);
    } catch (err: any) {
      righeErrore++;
      erroriPratiche.push({ messaggio: String(err?.message || err), dato: pratica });
    }
  });

  // ------------------------------------------------------------------
  // FASE 3: scritture in blocco, in parallelo (righe nuove, aggiornamenti,
  // storico, errori).
  // ------------------------------------------------------------------
  await Promise.all(
    inBlocchi(righeDaInserire, 500).map(async (blocco) => {
      const { error } = await supabase.from("pratica_righe").insert(blocco);
      if (error) throw error;
    })
  );

  // Gli aggiornamenti (a differenza degli inserimenti) toccano righe gia'
  // esistenti con valori diversi l'una dall'altra: non si possono
  // raggruppare in un'unica query, ma vengono comunque lanciati con la
  // stessa concorrenza controllata della FASE 2 invece che uno alla volta.
  const storicoRigheDaInserire: any[] = [];
  await eseguiConConcorrenza(aggiornamentiRiga, CONCORRENZA_PRATICHE, async (agg) => {
    const { error } = await supabase.from("pratica_righe").update(agg.payload).eq("id", agg.id);
    if (error) throw error;
    storicoRigheDaInserire.push({
      entita: "pratica_riga",
      entita_id: agg.id,
      campo: "status_riga",
      valore_precedente: agg.statoPrecedente,
      valore_nuovo: agg.statoNuovo,
      origine: "importazione_csv",
    });
  });

  await Promise.all(
    inBlocchi([...storicoPraticheDaInserire, ...storicoRigheDaInserire], 500).map((blocco) =>
      blocco.length > 0 ? supabase.from("storico_modifiche").insert(blocco) : Promise.resolve()
    )
  );

  const erroriDaRegistrare = [
    ...erroriPratiche.map((e) => ({ importazione_id: importazione.id, messaggio_errore: e.messaggio, dato_grezzo: e.dato })),
    ...erroriParsing.map((e) => ({
      importazione_id: importazione.id,
      numero_riga: e.numero_riga,
      messaggio_errore: e.messaggio,
      dato_grezzo: e.dato_grezzo,
    })),
  ];
  await Promise.all(
    inBlocchi(erroriDaRegistrare, 500).map((blocco) =>
      blocco.length > 0 ? supabase.from("importazioni_csv_errori").insert(blocco) : Promise.resolve()
    )
  );

  const totaleErrori = righeErrore + erroriParsing.length;
  const statoFinale: "completata" | "completata_con_errori" = totaleErrori > 0 ? "completata_con_errori" : "completata";

  await supabase
    .from("importazioni_csv")
    .update({
      righe_nuove: nuoveRighe,
      righe_aggiornate: praticheAggiornate,
      righe_invariate: praticheInvariate,
      righe_errore: totaleErrori,
      stato: statoFinale,
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  return {
    importazioneId: importazione.id,
    righeTotali: righe.length,
    praticheRilevate: pratiche.length,
    nuoveRighe,
    praticheAggiornate,
    praticheInvariate,
    praticheIgnorate,
    righeErrore,
    erroriParsing: erroriParsing.length,
    stato: statoFinale,
  };
}

/** Se dal Piano di Carico risulta gia' almeno una riga "Ordinato" o oltre,
 *  le fasi a monte sono evidentemente gia' avvenute: le completiamo anche
 *  se nessun operatore le ha mai segnate su Dasch (evita falsi allarmi su
 *  pratiche in realta' gia' avanzate da tempo). Stessa logica del CLI, ma
 *  legge le fasi attuali dalla mappa pre-caricata invece di interrogare il
 *  database (unica differenza rispetto allo script da terminale). */
async function completaFasiPregresse(
  supabase: any,
  praticaId: string,
  righe: any[],
  fasiIds: Record<string, string>,
  fasiAttuali: Map<string, any>
) {
  const almenoUnaOrdinata = righe.some((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  if (!almenoUnaOrdinata) return;

  const idFasiDaCompletare = [fasiIds.ricezione, fasiIds.presa_in_carico, fasiIds.apertura_pratica, fasiIds.creazione_commissione]
    .map((faseId) => fasiAttuali.get(faseId))
    .filter((f) => f && f.stato !== "completata")
    .map((f) => f.id);

  if (idFasiDaCompletare.length === 0) return;

  await supabase
    .from("pratica_fasi")
    .update({
      stato: "completata",
      data_effettiva: new Date().toISOString(),
      note: "Completata automaticamente: risulta gia' un ordine piazzato su Vamart (Piano di Carico), la fase e' evidentemente gia' avvenuta.",
    })
    .in("id", idFasiDaCompletare);
}

/** Fa avanzare "Invio ordine ricambi" / "Arrivo merce in deposito" /
 *  "Consegna materiale" in base allo stato aggregato delle righe. Identico
 *  al CLI, incluso il blocco umano: "arrivo_merce" non avanza mai finche'
 *  l'operatore non dichiara a mano "conferma_ordine" sulla pratica. Legge le
 *  fasi attuali dalla mappa pre-caricata invece che con una query dedicata. */
async function sincronizzaFasiDaRighe(
  supabase: any,
  praticaId: string,
  righe: any[],
  fasiIds: Record<string, string>,
  perFase: Map<string, any>
) {
  if (!righe || righe.length === 0) return;

  const tutteOrdinate = righe.every((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  const tutteConsegnate = righe.every((r) => r.status === "Consegnato");

  const faseConfermaOrdine = perFase.get(fasiIds.conferma_ordine);
  if (tutteOrdinate && faseConfermaOrdine && faseConfermaOrdine.stato === "da_iniziare") {
    await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseConfermaOrdine.id);
    faseConfermaOrdine.stato = "in_corso"; // aggiorna la mappa in memoria per coerenza nel resto di questa chiamata
  }
  const confermaOrdineFatta = faseConfermaOrdine?.stato === "completata";

  const passaggi = [
    { faseId: fasiIds.ordine_ricambi, condizione: tutteOrdinate, nota: "Tutte le righe risultano ordinate su Vamart (Piano di Carico)." },
    {
      faseId: fasiIds.arrivo_merce,
      condizione: tutteArrivate && confermaOrdineFatta,
      nota: "Tutte le righe risultano arrivate in giacenza su Vamart (Piano di Carico), dopo conferma ordine dichiarata dall'operatore.",
    },
    {
      faseId: fasiIds.consegna_materiale,
      condizione: tutteConsegnate && confermaOrdineFatta,
      nota: "Tutte le righe risultano consegnate su Vamart (Piano di Carico).",
    },
  ];

  for (const [indice, passaggio] of passaggi.entries()) {
    const faseCorrente = perFase.get(passaggio.faseId);
    if (!faseCorrente || faseCorrente.stato === "completata" || !passaggio.condizione) continue;

    await supabase
      .from("pratica_fasi")
      .update({ stato: "completata", data_effettiva: new Date().toISOString(), note: passaggio.nota })
      .eq("id", faseCorrente.id);
    faseCorrente.stato = "completata";

    const prossimoPassaggio = passaggi[indice + 1];
    if (prossimoPassaggio) {
      const faseSuccessiva = perFase.get(prossimoPassaggio.faseId);
      if (faseSuccessiva && faseSuccessiva.stato === "da_iniziare") {
        await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseSuccessiva.id);
        faseSuccessiva.stato = "in_corso";
      }
    } else {
      await supabase
        .from("pratiche")
        .update({ stato_generale: "chiusa", data_chiusura_effettiva: new Date().toISOString() })
        .eq("id", praticaId)
        .not("stato_generale", "in", "(chiusa,annullata)");
    }
  }
}
