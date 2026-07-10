// importVamartCsv.mjs
// Importatore CSV "Piano di carico" -> Supabase (pratica_righe + avanzamento fasi)
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importVamartCsv.mjs "/percorso/Piano di carico.csv"
//   (opzionale) ORIGINE_IMPORT=scraper_automatico ... per etichettare correttamente
//   la sessione in importazioni_csv quando invocato dallo scraper automatico
//   invece che a mano da terminale (default: "manuale").
//
// IMPORTANTE: il Piano di Carico esportato da Vamart contiene TUTTE le
// commissioni (vendite normali comprese), non solo quelle di assistenza.
// Per questo motivo questo importatore NON crea mai nuove pratiche: si
// limita ad aggiornare pratiche di assistenza gia' esistenti (create dalla
// segnalazione mail oppure dall'importatore "Commissioni - Solo di
// assistenza", vedi importCommissioniAssistenza.mjs). Se una riga del Piano
// di Carico non corrisponde a nessuna pratica esistente, viene ignorata:
// significa che quella commissione non e' di assistenza.
//
// PERFORMANCE (versione 2, riallineata a apps/web/lib/import/eseguiImportazione.ts):
// la prima versione di questo script faceva fino a 4 query al database PER
// RIGA, in sequenza -- con un Piano di Carico di ~2000+ pratiche distinte
// (migliaia di righe) questo richiedeva 15-20+ minuti anche su GitHub
// Actions (dove non c'e' il limite di 60s di Vercel, ma comunque troppo per
// un'automazione pensata per girare ogni ora). Questa versione, come
// l'importatore usato dal pannello admin:
//  - pre-carica in blocco (query .in(), a chunk, IN PARALLELO con Promise.all)
//    tutto cio' che serve per confrontare il CSV con lo stato attuale
//  - confronta in memoria e processa piu' pratiche in parallelo (worker pool,
//    vedi eseguiConConcorrenza) invece che una alla volta
//  - scrive righe nuove/aggiornamenti/storico in blocco, sempre in parallelo
//
// Comportamento (invariato rispetto alla versione precedente):
//  - riconosce pratiche esistenti tramite codice_commissione (chiave naturale del gestionale)
//  - ignora le righe la cui commissione non corrisponde a nessuna pratica di assistenza esistente
//  - per ogni riga: crea la riga se nuova, aggiorna solo i campi cambiati (via riga_hash) e
//    scrive un evento in storico_modifiche
//  - registra la sessione di importazione in importazioni_csv (+ errori riga per riga)
//  - se dal Piano di Carico risulta gia' un ordine piazzato (Status: Ordinato o
//    oltre) per almeno una riga, considera "gia' avvenute" anche le fasi a monte
//    (Ricezione segnalazione / Presa in carico / Apertura pratica / Creazione
//    commissione), anche se nessuno le ha mai segnate completate su Dasch --
//    vedi completaFasiPregresse.
//  - fa avanzare automaticamente le fasi "Invio ordine ricambi" e "Consegna
//    materiale" guardando lo stato aggregato delle righe della pratica
//    (Status: Da ordinare / Ordinato / In giacenza / Parzialmente consegnato
//    / Consegnato) -- vedi sincronizzaFasiDaRighe.
//    "Arrivo merce in deposito" e' invece SEMPRE bloccata finche' l'operatore
//    non dichiara manualmente "Conferma ordine" sulla schermata pratica (fase
//    conferma_ordine, mai gestita in automatico da questo importatore): e'
//    un controllo umano voluto, anche se Vamart segnala gia' merce arrivata.
//    Il cronometro di ogni fase riparte da solo grazie al trigger DB
//    trg_pratica_fasi_avvia_cronometro (creato a mano su Supabase, vedi
//    migrazione 0009_conferma_ordine.sql per il contesto completo).
//
// Questo modulo e' pensato per essere lanciato manualmente, da uno scheduler (cron) o
// invocato dallo scraper automatico (vedi /scraper) subito dopo il download del file.

import { createClient } from "@supabase/supabase-js";
import { parseFileCompleto } from "./parseCsv.mjs";
import { raggruppaInPratiche } from "./mapToDomain.mjs";

// Se l'ambiente di esecuzione richiede un proxy HTTP/HTTPS (es. reti aziendali
// o ambienti sandbox), lo configuriamo qui per il fetch globale di Node.
// In produzione (Vercel, server senza proxy, GitHub Actions) queste variabili
// non sono impostate e questo blocco non ha alcun effetto.
const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINE_IMPORT = process.env.ORIGINE_IMPORT || "manuale";

const FASI_NECESSARIE = [
  "ricezione",
  "presa_in_carico",
  "apertura_pratica",
  "creazione_commissione",
  "ordine_ricambi",
  "conferma_ordine",
  "arrivo_merce",
  "consegna_materiale",
];

const STATI_ORDINATO_O_OLTRE = new Set(["Ordinato", "In giacenza", "Parzialmente consegnato", "Consegnato"]);
const STATI_ARRIVATO_O_OLTRE = new Set(["In giacenza", "Parzialmente consegnato", "Consegnato"]);

// Le query con .in(...) hanno un limite pratico di lunghezza (URL/parametri):
// spezziamo le liste lunghe in blocchi di questa dimensione, lanciati poi
// tutti insieme (Promise.all), non uno alla volta.
const DIMENSIONE_BLOCCO = 300;

// Quante pratiche processare in parallelo nella FASE 2 (confronto CSV vs
// database + scritture puntuali per fase). Compromesso prudente tra
// velocita' e numero di connessioni simultanee al database.
const CONCORRENZA_PRATICHE = 20;

function inBlocchi(lista, dimensione = DIMENSIONE_BLOCCO) {
  const blocchi = [];
  for (let i = 0; i < lista.length; i += dimensione) blocchi.push(lista.slice(i, i + dimensione));
  return blocchi;
}

/** Esegue `fn` su ogni elemento di `elementi`, con al massimo `concorrenza`
 *  chiamate in volo contemporaneamente. */
async function eseguiConConcorrenza(elementi, concorrenza, fn) {
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

async function main() {
  const percorsoFile = process.argv[2];
  if (!percorsoFile) {
    console.error("Uso: node importVamartCsv.mjs <percorso-file-csv>");
    process.exit(1);
  }
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("Impostare le variabili d'ambiente SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

  // Fasi che questo importatore fa avanzare (o legge) in base allo stato
  // delle righe. Risolte per codice (non id fisso), cosi' restano valide
  // anche se qualcuno le ricrea dal pannello admin. "conferma_ordine" viene
  // solo LETTA (mai scritta automaticamente): serve per bloccare l'avanzamento
  // di "arrivo_merce" finche' l'operatore non l'ha dichiarata a mano.
  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", FASI_NECESSARIE);
  if (erroreFasi) throw erroreFasi;
  const fasiIds = Object.fromEntries(fasiWorkflow.map((f) => [f.codice, f.id]));
  for (const codice of FASI_NECESSARIE) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow (hai gia' applicato la migrazione 0009_conferma_ordine.sql?)`);
  }
  const tutteLeFasiRilevanti = Object.values(fasiIds);

  console.log(`Lettura file: ${percorsoFile}`);
  const { righe, errori: erroriParsing } = parseFileCompleto(percorsoFile);
  const pratiche = raggruppaInPratiche(righe);
  console.log(`Righe totali valide: ${righe.length}, pratiche distinte: ${pratiche.length}, errori parsing: ${erroriParsing.length}`);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: percorsoFile.split("/").pop(),
      origine: ORIGINE_IMPORT,
      righe_totali: righe.length,
      stato: "in_corso",
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  // ------------------------------------------------------------------
  // FASE 1: pre-carico in blocco, IN PARALLELO, tutto cio' che serve per
  // confrontare il CSV con lo stato attuale (elimina le query per-riga).
  // ------------------------------------------------------------------
  console.log("Fase 1/3: pre-carico pratiche/righe/fornitori/fasi esistenti...");

  const codiciCommissione = [...new Set(pratiche.map((p) => p.codice_commissione))];
  const mappaPraticheEsistenti = new Map();
  await Promise.all(
    inBlocchi(codiciCommissione).map(async (blocco) => {
      const { data, error } = await supabase.from("pratiche").select("*").in("codice_commissione", blocco);
      if (error) throw error;
      for (const p of data ?? []) mappaPraticheEsistenti.set(p.codice_commissione, p);
    })
  );
  const idPraticheEsistenti = [...mappaPraticheEsistenti.values()].map((p) => p.id);

  const mappaRigheEsistenti = new Map();
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

  const nomiFornitori = [...new Set(righe.map((r) => r.fornitore).filter(Boolean))];
  const mappaFornitori = new Map();
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

  const mappaFasiPerPratica = new Map();
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
        mappaFasiPerPratica.get(f.pratica_id).set(f.fase_id, f);
      }
    })
  );

  // ------------------------------------------------------------------
  // FASE 2: confronto in memoria + scritture puntuali, con piu' pratiche
  // lavorate in parallelo (worker pool) invece che una alla volta.
  // ------------------------------------------------------------------
  console.log(`Fase 2/3: confronto ${pratiche.length} pratiche (concorrenza ${CONCORRENZA_PRATICHE})...`);

  let nuove = 0, aggiornate = 0, invariate = 0, ignorate = 0, righeErrore = 0;
  const righeDaInserire = [];
  const aggiornamentiRiga = [];
  const storicoPraticheDaInserire = [];
  const erroriPratiche = [];

  await eseguiConConcorrenza(pratiche, CONCORRENZA_PRATICHE, async (pratica) => {
    try {
      const praticaEsistente = mappaPraticheEsistenti.get(pratica.codice_commissione);

      // Il Piano di Carico contiene TUTTE le commissioni Vamart, comprese le
      // vendite normali: se non esiste gia' una pratica di assistenza con
      // questo codice, questa riga non riguarda l'assistenza e va ignorata.
      if (!praticaEsistente) {
        ignorate++;
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
        aggiornate++;
      } else {
        invariate++;
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
    } catch (err) {
      righeErrore++;
      erroriPratiche.push({ messaggio: String(err.message || err), dato: pratica });
    }
  });

  // ------------------------------------------------------------------
  // FASE 3: scritture in blocco, in parallelo (righe nuove, aggiornamenti,
  // storico, errori) -- invece che una insert/update alla volta.
  // ------------------------------------------------------------------
  console.log(`Fase 3/3: scrittura ${righeDaInserire.length} righe nuove, ${aggiornamentiRiga.length} aggiornamenti...`);

  await Promise.all(
    inBlocchi(righeDaInserire, 500).map(async (blocco) => {
      if (blocco.length === 0) return;
      const { error } = await supabase.from("pratica_righe").insert(blocco);
      if (error) throw error;
    })
  );

  const storicoRigheDaInserire = [];
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
  await supabase
    .from("importazioni_csv")
    .update({
      righe_nuove: righeDaInserire.length,
      righe_aggiornate: aggiornate,
      righe_invariate: invariate,
      righe_errore: totaleErrori,
      stato: totaleErrori > 0 ? "completata_con_errori" : "completata",
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  console.log(`Import completata. Pratiche aggiornate: ${aggiornate}, invariate: ${invariate}, ignorate (non di assistenza): ${ignorate}, errori: ${totaleErrori}`);
}

// ---------------------------------------------------------------------
// Se dal Piano di Carico risulta gia' almeno una riga con Status "Ordinato"
// o oltre, significa che l'ordine e' evidentemente gia' partito su Vamart:
// completiamo retroattivamente anche le fasi a monte (Ricezione
// segnalazione / Presa in carico / Apertura pratica / Creazione
// commissione) se non lo sono gia', anche se nessun operatore le ha mai
// segnate completate a mano su Dasch. Legge le fasi attuali dalla mappa
// pre-caricata (fasiAttuali) invece di interrogare il database.
// ---------------------------------------------------------------------
async function completaFasiPregresse(supabase, praticaId, righe, fasiIds, fasiAttuali) {
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

// ---------------------------------------------------------------------
// Fa avanzare "Invio ordine ricambi" / "Arrivo merce in deposito" /
// "Consegna materiale" in base allo stato aggregato delle righe della
// pratica. Ogni fase si completa solo quando TUTTE le righe hanno
// raggiunto (almeno) lo stato corrispondente.
//
// ECCEZIONE IMPORTANTE: "arrivo_merce" (e quindi anche "consegna_materiale"
// a cascata) NON avanza mai finche' l'operatore non ha dichiarato a mano la
// fase "conferma_ordine" sulla schermata pratica. E' un controllo umano
// voluto: anche se Vamart segnala gia' merce in giacenza o consegnata, il
// sistema resta fermo su "conferma ordine" finche' un operatore non conferma
// di aver verificato di persona l'ordine. Legge/scrive le fasi attuali sulla
// mappa pre-caricata (perFase) invece che con query dedicate per pratica.
// ---------------------------------------------------------------------
async function sincronizzaFasiDaRighe(supabase, praticaId, righe, fasiIds, perFase) {
  if (!righe || righe.length === 0) return;

  const tutteOrdinate = righe.every((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  const tutteConsegnate = righe.every((r) => r.status === "Consegnato");

  const faseConfermaOrdine = perFase.get(fasiIds.conferma_ordine);
  if (tutteOrdinate && faseConfermaOrdine && faseConfermaOrdine.stato === "da_iniziare") {
    await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseConfermaOrdine.id);
    faseConfermaOrdine.stato = "in_corso";
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
      // Era l'ultimo passaggio (consegna_materiale): la pratica e' di
      // fatto conclusa, non deve piu' comparire tra quelle aperte/in ritardo.
      await supabase
        .from("pratiche")
        .update({ stato_generale: "chiusa", data_chiusura_effettiva: new Date().toISOString() })
        .eq("id", praticaId)
        .not("stato_generale", "in", "(chiusa,annullata)");
    }
  }
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exitCode = 1;
});
