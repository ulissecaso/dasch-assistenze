// importVamartCsv.mjs
// Importatore CSV "Piano di carico" -> Supabase (pratica_righe + avanzamento fasi)
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importVamartCsv.mjs "/percorso/Piano di carico.csv"
//   (opzionale) ORIGINE_IMPORT=scraper_automatico ... per etichettare correttamente
//   la sessione in importazioni_csv quando invocato dallo scraper automatico
//   invece che a mano da terminale (default: "manuale").
//   (opzionale) BRAND_CODICE=MASTERMOBILI ... per importare le pratiche di un
//   brand diverso da Cinquegrana (default: CINQUEGRANA, invariato rispetto a
//   prima). Cinquegrana e Master Mobili condividono lo stesso Vamart e lo
//   stesso formato CSV: e' questo unico script, invocato due volte con
//   BRAND_CODICE diverso, a gestire entrambi (vedi
//   .github/workflows/scraper-vamart.yml).
//
// Il Piano di Carico esportato da Vamart contiene TUTTE le commissioni
// (vendite normali comprese), non solo quelle di assistenza. Questo
// importatore gestisce entrambi i casi:
//  - se il codice_commissione corrisponde a una pratica di ASSISTENZA gia'
//    esistente (creata dalla segnalazione mail o da
//    importCommissioniAssistenza.mjs), la aggiorna (comportamento
//    invariato rispetto alle versioni precedenti di questo script);
//  - se non corrisponde a nessuna pratica esistente, e' una commissione
//    normale (non di assistenza): dalla versione con il modulo "Monitoraggio
//    Consegne" (vedi migrazione 0010_modulo_consegne.sql), invece di
//    ignorarla creiamo una nuova pratica con tipo='consegna', con il suo
//    workflow molto piu' semplice (due sole fasi umane: "Programma
//    consegna" e "Pagamento ricevuto", vedi sincronizzaFasiConsegna).
//
// PERFORMANCE: query in blocco/parallele invece che per-riga (vedi anche
// apps/web/lib/import/eseguiImportazione.ts, stessa tecnica).
//
// Fasi assistenza (invariato):
//  - "Arrivo merce in deposito" NON avanza mai finche' l'operatore non
//    dichiara manualmente "Conferma ordine" sulla schermata pratica: e' un
//    controllo umano voluto, anche se Vamart segnala gia' merce arrivata.
//
// Fasi consegna (nuovo):
//  - "Programma consegna" e "Pagamento ricevuto" partono insieme
//    (da_iniziare -> in_corso) quando TUTTE le righe della pratica
//    risultano arrivate in deposito (stesso set di stati Vamart usato per
//    "arrivo_merce" nell'assistenza). Si completano solo con una
//    dichiarazione manuale dell'operatore (vedi app/pratiche/[id]/
//    consegna-actions.ts), mai in automatico da questo importatore.
//  - Quando tutte le righe risultano "Consegnato", stato_generale passa a
//    "chiusa" tramite la stessa calcolaStatoGenerale/logica gia' esistente:
//    la pratica sparisce dal monitor come qualunque pratica chiusa.

import { createClient } from "@supabase/supabase-js";
import { parseFileCompleto } from "./parseCsv.mjs";
import { raggruppaInPratiche } from "./mapToDomain.mjs";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ORIGINE_IMPORT = process.env.ORIGINE_IMPORT || "manuale";
const BRAND_CODICE = process.env.BRAND_CODICE || "CINQUEGRANA";

const FASI_ASSISTENZA = [
  "ricezione",
  "presa_in_carico",
  "apertura_pratica",
  "creazione_commissione",
  "ordine_ricambi",
  "conferma_ordine",
  "arrivo_merce",
  "consegna_materiale",
];
const FASI_CONSEGNA = ["pianificazione_consegna", "pagamento"];

const STATI_ORDINATO_O_OLTRE = new Set(["Ordinato", "In giacenza", "Parzialmente consegnato", "Consegnato"]);
const STATI_ARRIVATO_O_OLTRE = new Set(["In giacenza", "Parzialmente consegnato", "Consegnato"]);

const DIMENSIONE_BLOCCO = 300;
const CONCORRENZA_PRATICHE = 20;

function inBlocchi(lista, dimensione = DIMENSIONE_BLOCCO) {
  const blocchi = [];
  for (let i = 0; i < lista.length; i += dimensione) blocchi.push(lista.slice(i, i + dimensione));
  return blocchi;
}

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

function payloadRigaDa(praticaId, riga, mappaFornitori) {
  const fornitoreId = riga.fornitore ? mappaFornitori.get(riga.fornitore) ?? null : null;
  return {
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

  const { data: brand, error: erroreBrand } = await supabase
    .from("brands")
    .select("id, nome")
    .eq("codice", BRAND_CODICE)
    .maybeSingle();
  if (erroreBrand) throw erroreBrand;
  if (!brand) throw new Error(`Brand '${BRAND_CODICE}' non trovato in brands (hai gia' applicato la migrazione 0011_multi_brand.sql?)`);
  const brandId = brand.id;
  console.log(`Brand: ${brand.nome} (${BRAND_CODICE})`);

  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", [...FASI_ASSISTENZA, ...FASI_CONSEGNA]);
  if (erroreFasi) throw erroreFasi;
  const fasiIds = Object.fromEntries(fasiWorkflow.map((f) => [f.codice, f.id]));
  for (const codice of FASI_ASSISTENZA) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow (hai gia' applicato la migrazione 0009_conferma_ordine.sql?)`);
  }
  for (const codice of FASI_CONSEGNA) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow (hai gia' applicato la migrazione 0010_modulo_consegne.sql?)`);
  }
  const tutteLeFasiRilevanti = Object.values(fasiIds);

  console.log(`Lettura file: ${percorsoFile}`);
  const { righe, errori: erroriParsing } = parseFileCompleto(percorsoFile);
  const pratiche = raggruppaInPratiche(righe);
  console.log(`Righe totali valide: ${righe.length}, pratiche distinte: ${pratiche.length}, errori parsing: ${erroriParsing.length}`);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({ nome_file: percorsoFile.split("/").pop(), origine: ORIGINE_IMPORT, righe_totali: righe.length, stato: "in_corso", brand_id: brandId })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  // ------------------------------------------------------------------
  // FASE 1: pre-carico in blocco, IN PARALLELO, tutto cio' che serve.
  // ------------------------------------------------------------------
  console.log("Fase 1/4: pre-carico pratiche/righe/fornitori/clienti/fasi esistenti...");

  const codiciCommissione = [...new Set(pratiche.map((p) => p.codice_commissione))];
  const mappaPraticheEsistenti = new Map();
  await Promise.all(
    inBlocchi(codiciCommissione).map(async (blocco) => {
      const { data, error } = await supabase.from("pratiche").select("*").eq("brand_id", brandId).in("codice_commissione", blocco);
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
        const { data, error } = await supabase.from("fornitori").insert(blocco.map((ragione_sociale) => ({ ragione_sociale }))).select("id, ragione_sociale");
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

  // Clienti: servono solo per le commissioni NON di assistenza (candidate
  // "consegna"), gia' esistenti o da creare al volo.
  const praticheDaCreare = pratiche.filter((p) => !mappaPraticheEsistenti.has(p.codice_commissione));
  const nomiClienti = [...new Set(praticheDaCreare.map((p) => p.cliente).filter(Boolean))];
  const mappaClienti = new Map();
  if (nomiClienti.length > 0) {
    await Promise.all(
      inBlocchi(nomiClienti).map(async (blocco) => {
        const { data, error } = await supabase.from("clienti").select("id, nome_completo").eq("brand_id", brandId).in("nome_completo", blocco);
        if (error) throw error;
        for (const c of data ?? []) mappaClienti.set(c.nome_completo, c.id);
      })
    );
    const clientiMancanti = nomiClienti.filter((n) => !mappaClienti.has(n));
    if (clientiMancanti.length > 0) {
      await Promise.all(
        inBlocchi(clientiMancanti, 500).map(async (blocco) => {
          const { data, error } = await supabase.from("clienti").insert(blocco.map((nome_completo) => ({ nome_completo, brand_id: brandId }))).select("id, nome_completo");
          if (error) throw error;
          for (const c of data ?? []) mappaClienti.set(c.nome_completo, c.id);
        })
      );
    }
  }

  // ------------------------------------------------------------------
  // FASE 2: confronto in memoria + scritture puntuali (pratiche esistenti,
  // sempre di assistenza), con piu' pratiche lavorate in parallelo.
  // ------------------------------------------------------------------
  console.log(`Fase 2/4: confronto ${pratiche.length - praticheDaCreare.length} pratiche di assistenza esistenti (concorrenza ${CONCORRENZA_PRATICHE})...`);

  let aggiornate = 0, invariate = 0, righeErrore = 0;
  const righeDaInserire = [];
  const aggiornamentiRiga = [];
  const storicoPraticheDaInserire = [];
  const erroriPratiche = [];

  const praticheEsistentiDaConfrontare = pratiche.filter((p) => mappaPraticheEsistenti.has(p.codice_commissione));

  await eseguiConConcorrenza(praticheEsistentiDaConfrontare, CONCORRENZA_PRATICHE, async (pratica) => {
    try {
      const praticaEsistente = mappaPraticheEsistenti.get(pratica.codice_commissione);
      const praticaId = praticaEsistente.id;

      if (praticaEsistente.stato_generale !== pratica.stato_generale) {
        await supabase.from("pratiche").update({ stato_generale: pratica.stato_generale }).eq("id", praticaId);
        storicoPraticheDaInserire.push({
          entita: "pratica", entita_id: praticaId, campo: "stato_generale",
          valore_precedente: praticaEsistente.stato_generale, valore_nuovo: pratica.stato_generale, origine: "importazione_csv",
        });
        aggiornate++;
      } else {
        invariate++;
      }

      for (const riga of pratica.righe) {
        const chiave = `${praticaId}|${riga.codice_articolo}|${riga.descrizione}`;
        const rigaEsistente = mappaRigheEsistenti.get(chiave);
        const payload = payloadRigaDa(praticaId, riga, mappaFornitori);
        if (!rigaEsistente) {
          righeDaInserire.push(payload);
        } else if (rigaEsistente.riga_hash !== riga.riga_hash) {
          aggiornamentiRiga.push({ id: rigaEsistente.id, payload, statoPrecedente: rigaEsistente.status_riga, statoNuovo: riga.status });
        }
      }

      const fasiDiQuestaPratica = mappaFasiPerPratica.get(praticaId) ?? new Map();
      if (praticaEsistente.tipo === "consegna") {
        await sincronizzaFasiConsegna(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica);
      } else {
        await completaFasiPregresseAssistenza(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica);
        await sincronizzaFasiAssistenza(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica);
      }
    } catch (err) {
      righeErrore++;
      erroriPratiche.push({ messaggio: String(err.message || err), dato: pratica });
    }
  });

  // ------------------------------------------------------------------
  // FASE 2.5: crea le pratiche "consegna" per le commissioni normali (non
  // di assistenza) che non esistevano ancora. Le loro righe/fasi si
  // scrivono qui perche' servono gli id appena assegnati dal database.
  // ------------------------------------------------------------------
  let nuoveConsegne = 0;
  if (praticheDaCreare.length > 0) {
    console.log(`Fase 2.5/4: creo ${praticheDaCreare.length} nuove pratiche di consegna (commissioni normali non ancora tracciate)...`);

    const payloadNuovePratiche = praticheDaCreare.map((p) => ({
      codice_commissione: p.codice_commissione,
      codice_commissione_riferimento: p.codice_commissione,
      cliente_id: mappaClienti.get(p.cliente),
      brand_id: brandId,
      tipo: "consegna",
      categoria: p.categoria,
      canale_origine: "csv",
      fonte_dati: "csv",
      stato_generale: p.stato_generale,
      data_apertura: p.data_commissione || new Date().toISOString(),
      data_consegna_prevista: p.data_consegna_cliente,
    }));

    const mappaNuovePratiche = new Map(); // codice_commissione -> id
    await Promise.all(
      inBlocchi(payloadNuovePratiche, 500).map(async (blocco) => {
        const { data, error } = await supabase.from("pratiche").insert(blocco).select("id, codice_commissione");
        if (error) throw error;
        for (const p of data ?? []) mappaNuovePratiche.set(p.codice_commissione, p.id);
      })
    );
    nuoveConsegne = mappaNuovePratiche.size;

    for (const p of praticheDaCreare) {
      const praticaId = mappaNuovePratiche.get(p.codice_commissione);
      if (!praticaId) continue; // errore d'inserimento per questa pratica, gia' non presente nella mappa
      for (const riga of p.righe) righeDaInserire.push(payloadRigaDa(praticaId, riga, mappaFornitori));
    }

    // Le fasi (pianificazione_consegna, pagamento) sono gia' state create in
    // automatico dal trigger DB trg_fn_inizializza_fasi_pratica (entrambe
    // "da_iniziare"): le rileggiamo in blocco per poterle eventualmente
    // attivare subito se la merce risulta gia' tutta arrivata.
    const idNuovePratiche = [...mappaNuovePratiche.values()];
    const mappaFasiNuovePratiche = new Map();
    await Promise.all(
      inBlocchi(idNuovePratiche).map(async (blocco) => {
        const { data, error } = await supabase
          .from("pratica_fasi")
          .select("id, pratica_id, fase_id, stato")
          .in("pratica_id", blocco)
          .in("fase_id", [fasiIds.pianificazione_consegna, fasiIds.pagamento]);
        if (error) throw error;
        for (const f of data ?? []) {
          if (!mappaFasiNuovePratiche.has(f.pratica_id)) mappaFasiNuovePratiche.set(f.pratica_id, new Map());
          mappaFasiNuovePratiche.get(f.pratica_id).set(f.fase_id, f);
        }
      })
    );

    await eseguiConConcorrenza(praticheDaCreare, CONCORRENZA_PRATICHE, async (p) => {
      const praticaId = mappaNuovePratiche.get(p.codice_commissione);
      if (!praticaId) return;
      const fasiDiQuestaPratica = mappaFasiNuovePratiche.get(praticaId) ?? new Map();
      await sincronizzaFasiConsegna(supabase, praticaId, p.righe, fasiIds, fasiDiQuestaPratica);
    });
  }

  // ------------------------------------------------------------------
  // FASE 3: scritture in blocco, in parallelo.
  // ------------------------------------------------------------------
  console.log(`Fase 3/4: scrittura ${righeDaInserire.length} righe nuove, ${aggiornamentiRiga.length} aggiornamenti...`);

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
      entita: "pratica_riga", entita_id: agg.id, campo: "status_riga",
      valore_precedente: agg.statoPrecedente, valore_nuovo: agg.statoNuovo, origine: "importazione_csv",
    });
  });

  await Promise.all(
    inBlocchi([...storicoPraticheDaInserire, ...storicoRigheDaInserire], 500).map((blocco) =>
      blocco.length > 0 ? supabase.from("storico_modifiche").insert(blocco) : Promise.resolve()
    )
  );

  const erroriDaRegistrare = [
    ...erroriPratiche.map((e) => ({ importazione_id: importazione.id, messaggio_errore: e.messaggio, dato_grezzo: e.dato })),
    ...erroriParsing.map((e) => ({ importazione_id: importazione.id, numero_riga: e.numero_riga, messaggio_errore: e.messaggio, dato_grezzo: e.dato_grezzo })),
  ];
  await Promise.all(
    inBlocchi(erroriDaRegistrare, 500).map((blocco) => (blocco.length > 0 ? supabase.from("importazioni_csv_errori").insert(blocco) : Promise.resolve()))
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

  console.log(
    `Import completata. Assistenza: ${aggiornate} aggiornate, ${invariate} invariate. Consegne: ${nuoveConsegne} nuove pratiche create. Errori: ${totaleErrori}`
  );
}

// ---------------------------------------------------------------------
// ASSISTENZA (invariato)
// ---------------------------------------------------------------------
async function completaFasiPregresseAssistenza(supabase, praticaId, righe, fasiIds, fasiAttuali) {
  const almenoUnaOrdinata = righe.some((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  if (!almenoUnaOrdinata) return;

  const idFasiDaCompletare = [fasiIds.ricezione, fasiIds.presa_in_carico, fasiIds.apertura_pratica, fasiIds.creazione_commissione]
    .map((faseId) => fasiAttuali.get(faseId))
    .filter((f) => f && f.stato !== "completata")
    .map((f) => f.id);

  if (idFasiDaCompletare.length === 0) return;

  await supabase
    .from("pratica_fasi")
    .update({ stato: "completata", data_effettiva: new Date().toISOString(), note: "Completata automaticamente: risulta gia' un ordine piazzato su Vamart (Piano di Carico), la fase e' evidentemente gia' avvenuta." })
    .in("id", idFasiDaCompletare);
}

async function sincronizzaFasiAssistenza(supabase, praticaId, righe, fasiIds, perFase) {
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
    { faseId: fasiIds.arrivo_merce, condizione: tutteArrivate && confermaOrdineFatta, nota: "Tutte le righe risultano arrivate in giacenza su Vamart (Piano di Carico), dopo conferma ordine dichiarata dall'operatore." },
    { faseId: fasiIds.consegna_materiale, condizione: tutteConsegnate && confermaOrdineFatta, nota: "Tutte le righe risultano consegnate su Vamart (Piano di Carico)." },
  ];

  for (const [indice, passaggio] of passaggi.entries()) {
    const faseCorrente = perFase.get(passaggio.faseId);
    if (!faseCorrente || faseCorrente.stato === "completata" || !passaggio.condizione) continue;

    await supabase.from("pratica_fasi").update({ stato: "completata", data_effettiva: new Date().toISOString(), note: passaggio.nota }).eq("id", faseCorrente.id);
    faseCorrente.stato = "completata";

    const prossimoPassaggio = passaggi[indice + 1];
    if (prossimoPassaggio) {
      const faseSuccessiva = perFase.get(prossimoPassaggio.faseId);
      if (faseSuccessiva && faseSuccessiva.stato === "da_iniziare") {
        await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseSuccessiva.id);
        faseSuccessiva.stato = "in_corso";
      }
    } else {
      await supabase.from("pratiche").update({ stato_generale: "chiusa", data_chiusura_effettiva: new Date().toISOString() }).eq("id", praticaId).not("stato_generale", "in", "(chiusa,annullata)");
    }
  }
}

// ---------------------------------------------------------------------
// CONSEGNA (nuovo): workflow a due sole fasi umane, "Programma consegna" e
// "Pagamento ricevuto", che partono INSIEME (non in sequenza) quando tutte
// le righe risultano arrivate in deposito. Si completano solo con una
// dichiarazione manuale dell'operatore (vedi consegna-actions.ts), mai in
// automatico da questo importatore -- stesso principio di "conferma_ordine"
// nell'assistenza: un controllo umano voluto su consegna e pagamento.
// Quando tutte le righe risultano "Consegnato", stato_generale diventa
// "chiusa" (calcolato da calcolaStatoGenerale in mapToDomain.mjs, gia'
// scritto dal chiamante prima di questa funzione): la pratica sparisce dal
// monitor come qualunque altra pratica chiusa, nessuna azione qui.
// ---------------------------------------------------------------------
async function sincronizzaFasiConsegna(supabase, praticaId, righe, fasiIds, perFase) {
  if (!righe || righe.length === 0) return;

  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  if (!tutteArrivate) return;

  const daAttivare = [fasiIds.pianificazione_consegna, fasiIds.pagamento]
    .map((faseId) => perFase.get(faseId))
    .filter((f) => f && f.stato === "da_iniziare")
    .map((f) => f.id);

  if (daAttivare.length === 0) return;

  await supabase
    .from("pratica_fasi")
    .update({ stato: "in_corso" })
    .in("id", daAttivare);
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exitCode = 1;
});
