// lib/import/eseguiImportazione.ts
// Logica di scrittura condivisa dell'importazione "Piano di Carico" Vamart.
//
// Il Piano di Carico contiene TUTTE le commissioni Vamart (vendite normali
// comprese, non solo assistenza). Da quando esiste il modulo "Monitoraggio
// Consegne" (vedi migrazione 0010_modulo_consegne.sql), le commissioni che
// non corrispondono a nessuna pratica di ASSISTENZA esistente non vengono
// piu' ignorate: diventano nuove pratiche con tipo='consegna', con un
// workflow molto piu' semplice (due sole fasi umane, "Programma consegna" e
// "Pagamento ricevuto", vedi sincronizzaFasiConsegna).
//
// PERFORMANCE (storia in 3 tentativi, vedi commenti piu' sotto per il
// dettaglio): query in blocco (chunk, .in()) lanciate IN PARALLELO
// (Promise.all) invece che in sequenza, e piu' pratiche lavorate in
// parallelo con un worker pool (eseguiConConcorrenza) invece che una alla
// volta: il tempo totale diventa quello del blocco piu' lento, non la
// somma di tutti.
import { parseFileCompletoDaTesto } from "./parseCsvTesto";
import { raggruppaInPratiche } from "./mapToDomain";

const FASI_ASSISTENZA = [
  "ricezione",
  "presa_in_carico",
  "apertura_pratica",
  "creazione_commissione",
  "ordine_ricambi",
  "conferma_ordine",
  "arrivo_merce",
  "consegna_materiale",
] as const;
const FASI_CONSEGNA = ["pianificazione_consegna", "pagamento"] as const;

const STATI_ORDINATO_O_OLTRE = new Set(["Ordinato", "In giacenza", "Parzialmente consegnato", "Consegnato"]);
const STATI_ARRIVATO_O_OLTRE = new Set(["In giacenza", "Parzialmente consegnato", "Consegnato"]);

const DIMENSIONE_BLOCCO = 300;
const CONCORRENZA_PRATICHE = 20;

function inBlocchi<T>(lista: T[], dimensione = DIMENSIONE_BLOCCO): T[][] {
  const blocchi: T[][] = [];
  for (let i = 0; i < lista.length; i += dimensione) blocchi.push(lista.slice(i, i + dimensione));
  return blocchi;
}

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

function payloadRigaDa(praticaId: string, riga: any, mappaFornitori: Map<string, string>) {
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

export type RisultatoImportazione = {
  importazioneId: string;
  righeTotali: number;
  praticheRilevate: number;
  nuoveRighe: number;
  praticheAggiornate: number;
  praticheInvariate: number;
  praticheIgnorate: number;
  nuoveConsegne: number;
  righeErrore: number;
  erroriParsing: number;
  stato: "completata" | "completata_con_errori";
};

/** Esegue l'importazione completa di un CSV "Piano di Carico" Vamart. */
export async function eseguiImportazioneCsv(
  supabase: any,
  testoCsv: string,
  opzioni: {
    nomeFile: string;
    origine?: "manuale" | "scraper_automatico" | "api";
    /** Codice del brand a cui appartiene questo CSV (vedi tabella brands): default CINQUEGRANA per compatibilita'. */
    brandCodice?: string;
  }
): Promise<RisultatoImportazione> {
  const origine = opzioni.origine ?? "manuale";
  const brandCodice = opzioni.brandCodice ?? "CINQUEGRANA";

  const { data: brand, error: erroreBrand } = await supabase
    .from("brands")
    .select("id, richiede_consegna_assistenza")
    .eq("codice", brandCodice)
    .maybeSingle();
  if (erroreBrand) throw erroreBrand;
  if (!brand) throw new Error(`Brand '${brandCodice}' non trovato in brands (migrazione 0011_multi_brand.sql applicata?)`);
  const brandId = brand.id as string;
  // Vedi 0014_richiede_consegna_brand.sql: se false, l'assistenza di questo
  // brand si chiude gia' all'arrivo merce, senza aspettare una consegna
  // tracciata a parte. Default true se la colonna non esiste ancora
  // (migrazione non applicata) o e' null, per compatibilita'.
  const richiedeConsegna = brand.richiede_consegna_assistenza ?? true;

  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", [...FASI_ASSISTENZA, ...FASI_CONSEGNA] as unknown as string[]);
  if (erroreFasi) throw erroreFasi;

  const fasiIds: Record<string, string> = Object.fromEntries((fasiWorkflow ?? []).map((f: any) => [f.codice, f.id]));
  for (const codice of FASI_ASSISTENZA) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow (migrazione 0009_conferma_ordine.sql applicata?)`);
  }
  for (const codice of FASI_CONSEGNA) {
    if (!fasiIds[codice]) throw new Error(`Fase '${codice}' non trovata in fasi_workflow (migrazione 0010_modulo_consegne.sql applicata?)`);
  }
  const tutteLeFasiRilevanti = Object.values(fasiIds);

  const { righe, errori: erroriParsing } = parseFileCompletoDaTesto(testoCsv);
  const pratiche = raggruppaInPratiche(righe);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({ nome_file: opzioni.nomeFile, origine, righe_totali: righe.length, stato: "in_corso", brand_id: brandId })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  // ------------------------------------------------------------------
  // FASE 1: pre-carico in blocco, IN PARALLELO, tutto cio' che serve.
  // ------------------------------------------------------------------
  const codiciCommissione = [...new Set(pratiche.map((p: any) => p.codice_commissione))];
  const mappaPraticheEsistenti = new Map<string, any>();
  await Promise.all(
    inBlocchi(codiciCommissione).map(async (blocco) => {
      const { data, error } = await supabase.from("pratiche").select("*").eq("brand_id", brandId).in("codice_commissione", blocco);
      if (error) throw error;
      for (const p of data ?? []) mappaPraticheEsistenti.set(p.codice_commissione, p);
    })
  );
  const idPraticheEsistenti = [...mappaPraticheEsistenti.values()].map((p) => p.id);

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
        const { data, error } = await supabase.from("fornitori").insert(blocco.map((ragione_sociale) => ({ ragione_sociale }))).select("id, ragione_sociale");
        if (error) throw error;
        for (const f of data ?? []) mappaFornitori.set(f.ragione_sociale, f.id);
      })
    );
  }

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

  // Clienti: servono solo per le commissioni NON di assistenza (candidate
  // "consegna"), gia' esistenti o da creare al volo.
  const praticheDaCreare = pratiche.filter((p: any) => !mappaPraticheEsistenti.has(p.codice_commissione));
  const nomiClienti = [...new Set(praticheDaCreare.map((p: any) => p.cliente).filter(Boolean))] as string[];
  const mappaClienti = new Map<string, string>();
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
  // FASE 2: confronto in memoria + scritture puntuali per le pratiche di
  // ASSISTENZA gia' esistenti, con piu' pratiche lavorate in parallelo.
  // ------------------------------------------------------------------
  let praticheAggiornate = 0;
  let praticheInvariate = 0;
  let righeErrore = 0;

  const righeDaInserire: any[] = [];
  const aggiornamentiRiga: { id: string; payload: any; statoPrecedente: string | null; statoNuovo: string | null }[] = [];
  const storicoPraticheDaInserire: any[] = [];
  const erroriPratiche: { messaggio: string; dato: any }[] = [];

  const praticheEsistentiDaConfrontare = pratiche.filter((p: any) => mappaPraticheEsistenti.has(p.codice_commissione));

  await eseguiConConcorrenza(praticheEsistentiDaConfrontare, CONCORRENZA_PRATICHE, async (pratica: any) => {
    try {
      const praticaEsistente = mappaPraticheEsistenti.get(pratica.codice_commissione);
      const praticaId = praticaEsistente.id;

      if (praticaEsistente.stato_generale !== pratica.stato_generale) {
        await supabase.from("pratiche").update({ stato_generale: pratica.stato_generale }).eq("id", praticaId);
        storicoPraticheDaInserire.push({
          entita: "pratica", entita_id: praticaId, campo: "stato_generale",
          valore_precedente: praticaEsistente.stato_generale, valore_nuovo: pratica.stato_generale, origine: "importazione_csv",
        });
        praticheAggiornate++;
      } else {
        praticheInvariate++;
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
        await sincronizzaFasiAssistenza(supabase, praticaId, pratica.righe, fasiIds, fasiDiQuestaPratica, richiedeConsegna);
      }
    } catch (err: any) {
      righeErrore++;
      erroriPratiche.push({ messaggio: String(err?.message || err), dato: pratica });
    }
  });

  // ------------------------------------------------------------------
  // FASE 2.5: crea le pratiche "consegna" per le commissioni normali che
  // non esistevano ancora (vedi migrazione 0010_modulo_consegne.sql).
  // ------------------------------------------------------------------
  let nuoveConsegne = 0;
  if (praticheDaCreare.length > 0) {
    const payloadNuovePratiche = praticheDaCreare.map((p: any) => ({
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

    const mappaNuovePratiche = new Map<string, string>();
    await Promise.all(
      inBlocchi(payloadNuovePratiche, 500).map(async (blocco) => {
        if (blocco.length === 0) return;
        const { data, error } = await supabase.from("pratiche").insert(blocco).select("id, codice_commissione");
        if (error) throw error;
        for (const p of data ?? []) mappaNuovePratiche.set(p.codice_commissione, p.id);
      })
    );
    nuoveConsegne = mappaNuovePratiche.size;

    for (const p of praticheDaCreare) {
      const praticaId = mappaNuovePratiche.get(p.codice_commissione);
      if (!praticaId) continue;
      for (const riga of p.righe) righeDaInserire.push(payloadRigaDa(praticaId, riga, mappaFornitori));
    }

    const idNuovePratiche = [...mappaNuovePratiche.values()];
    const mappaFasiNuovePratiche = new Map<string, Map<string, any>>();
    await Promise.all(
      inBlocchi(idNuovePratiche).map(async (blocco) => {
        if (blocco.length === 0) return;
        const { data, error } = await supabase
          .from("pratica_fasi")
          .select("id, pratica_id, fase_id, stato")
          .in("pratica_id", blocco)
          .in("fase_id", [fasiIds.pianificazione_consegna, fasiIds.pagamento]);
        if (error) throw error;
        for (const f of data ?? []) {
          if (!mappaFasiNuovePratiche.has(f.pratica_id)) mappaFasiNuovePratiche.set(f.pratica_id, new Map());
          mappaFasiNuovePratiche.get(f.pratica_id)!.set(f.fase_id, f);
        }
      })
    );

    await eseguiConConcorrenza(praticheDaCreare, CONCORRENZA_PRATICHE, async (p: any) => {
      const praticaId = mappaNuovePratiche.get(p.codice_commissione);
      if (!praticaId) return;
      const fasiDiQuestaPratica = mappaFasiNuovePratiche.get(praticaId) ?? new Map();
      await sincronizzaFasiConsegna(supabase, praticaId, p.righe, fasiIds, fasiDiQuestaPratica);
    });
  }

  // ------------------------------------------------------------------
  // FASE 3: scritture in blocco, in parallelo.
  // ------------------------------------------------------------------
  await Promise.all(
    inBlocchi(righeDaInserire, 500).map(async (blocco) => {
      if (blocco.length === 0) return;
      const { error } = await supabase.from("pratica_righe").insert(blocco);
      if (error) throw error;
    })
  );

  const storicoRigheDaInserire: any[] = [];
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
      righe_nuove: righeDaInserire.length,
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
    nuoveRighe: righeDaInserire.length,
    praticheAggiornate,
    praticheInvariate,
    praticheIgnorate: 0,
    nuoveConsegne,
    righeErrore,
    erroriParsing: erroriParsing.length,
    stato: statoFinale,
  };
}

// ---------------------------------------------------------------------
// ASSISTENZA (invariato rispetto alla versione precedente)
// ---------------------------------------------------------------------
async function completaFasiPregresseAssistenza(
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

async function sincronizzaFasiAssistenza(
  supabase: any,
  praticaId: string,
  righe: any[],
  fasiIds: Record<string, string>,
  perFase: Map<string, any>,
  // Vedi 0014_richiede_consegna_brand.sql. true (default storico) = la
  // pratica si chiude solo dopo "Consegna materiale" (comportamento
  // invariato). false = si chiude gia' all'arrivo merce, senza aspettare una
  // consegna tracciata a parte.
  richiedeConsegna: boolean = true
) {
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

  const passaggi = richiedeConsegna
    ? [
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
      ]
    : [
        { faseId: fasiIds.ordine_ricambi, condizione: tutteOrdinate, nota: "Tutte le righe risultano ordinate su Vamart (Piano di Carico)." },
        {
          faseId: fasiIds.arrivo_merce,
          condizione: tutteArrivate && confermaOrdineFatta,
          nota: "Tutte le righe risultano arrivate in giacenza su Vamart (Piano di Carico), dopo conferma ordine dichiarata dall'operatore. Consegna materiale non richiesta per questo brand: la pratica si chiude qui.",
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

      // La fase "consegna materiale" esiste comunque per ogni pratica
      // (creata dal trigger di inizializzazione), ma se non richiesta per
      // questo brand resterebbe per sempre "da iniziare": la marchiamo
      // completata con una nota esplicativa, cosi' la timeline della pratica
      // resta pulita e non genera falsi alert nel Monitor.
      if (!richiedeConsegna) {
        const faseConsegnaMateriale = perFase.get(fasiIds.consegna_materiale);
        if (faseConsegnaMateriale && faseConsegnaMateriale.stato !== "completata") {
          await supabase
            .from("pratica_fasi")
            .update({
              stato: "completata",
              data_effettiva: new Date().toISOString(),
              note: "Non richiesta per questo brand: la pratica si chiude senza tracciare una consegna separata.",
            })
            .eq("id", faseConsegnaMateriale.id);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------
// CONSEGNA (nuovo): due sole fasi umane, "Programma consegna" e "Pagamento
// ricevuto", che partono INSIEME quando tutte le righe risultano arrivate
// in deposito. Si completano solo con una dichiarazione manuale
// dell'operatore, mai in automatico da questo importatore -- stesso
// principio di "conferma_ordine" nell'assistenza.
// ---------------------------------------------------------------------
async function sincronizzaFasiConsegna(
  supabase: any,
  praticaId: string,
  righe: any[],
  fasiIds: Record<string, string>,
  perFase: Map<string, any>
) {
  if (!righe || righe.length === 0) return;

  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  if (!tutteArrivate) return;

  const daAttivare = [fasiIds.pianificazione_consegna, fasiIds.pagamento]
    .map((faseId) => perFase.get(faseId))
    .filter((f) => f && f.stato === "da_iniziare")
    .map((f) => f.id);

  if (daAttivare.length === 0) return;

  await supabase.from("pratica_fasi").update({ stato: "in_corso" }).in("id", daAttivare);
}
