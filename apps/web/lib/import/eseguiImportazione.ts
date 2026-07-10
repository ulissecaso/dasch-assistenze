// lib/import/eseguiImportazione.ts
// Logica di scrittura condivisa dell'importazione "Piano di Carico" Vamart:
// stessa identica logica di scripts/import-csv/importVamartCsv.mjs (CLI),
// portata in TypeScript per essere richiamabile anche dalla Route Handler
// /api/import-csv (upload manuale dal pannello admin) e in futuro da un
// eventuale trigger automatico (scraper/scheduler), senza duplicare la
// logica di scrittura in due posti che potrebbero disallinearsi.
//
// NOTA: il CLI (scripts/import-csv/importVamartCsv.mjs) resta com'e' e
// continua a funzionare da solo (uso via terminale, gia' testato in
// produzione): non l'abbiamo toccato per non rischiare di romperlo. Questo
// file e' la stessa logica riscritta per essere eseguita dentro Next.js.
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

  let nuoveRighe = 0;
  let praticheAggiornate = 0;
  let praticheInvariate = 0;
  let praticheIgnorate = 0;
  let righeErrore = 0;

  for (const pratica of pratiche) {
    try {
      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("*")
        .eq("codice_commissione", pratica.codice_commissione)
        .maybeSingle();

      // Il Piano di Carico contiene TUTTE le commissioni Vamart (anche
      // vendite normali): se non esiste gia' una pratica di assistenza con
      // questo codice, la riga non riguarda l'assistenza e va ignorata.
      if (!praticaEsistente) {
        praticheIgnorate++;
        continue;
      }

      const praticaId = praticaEsistente.id;
      if (praticaEsistente.stato_generale !== pratica.stato_generale) {
        await supabase.from("pratiche").update({ stato_generale: pratica.stato_generale }).eq("id", praticaId);
        await supabase.from("storico_modifiche").insert({
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
        let fornitoreId: string | null = null;
        if (riga.fornitore) {
          const { data: fornitoreEsistente } = await supabase
            .from("fornitori")
            .select("id")
            .eq("ragione_sociale", riga.fornitore)
            .maybeSingle();
          fornitoreId = fornitoreEsistente?.id ?? null;
          if (!fornitoreId) {
            const { data: nuovoFornitore, error } = await supabase
              .from("fornitori")
              .insert({ ragione_sociale: riga.fornitore })
              .select()
              .single();
            if (error) throw error;
            fornitoreId = nuovoFornitore.id;
          }
        }

        const { data: rigaEsistente } = await supabase
          .from("pratica_righe")
          .select("id, riga_hash, status_riga")
          .eq("pratica_id", praticaId)
          .eq("codice_articolo", riga.codice_articolo)
          .eq("descrizione", riga.descrizione)
          .maybeSingle();

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
          const { error } = await supabase.from("pratica_righe").insert(payloadRiga);
          if (error) throw error;
          nuoveRighe++;
        } else if (rigaEsistente.riga_hash !== riga.riga_hash) {
          const { error } = await supabase.from("pratica_righe").update(payloadRiga).eq("id", rigaEsistente.id);
          if (error) throw error;
          await supabase.from("storico_modifiche").insert({
            entita: "pratica_riga",
            entita_id: rigaEsistente.id,
            campo: "status_riga",
            valore_precedente: rigaEsistente.status_riga,
            valore_nuovo: riga.status,
            origine: "importazione_csv",
          });
        }
      }

      await completaFasiPregresse(supabase, praticaId, pratica.righe, fasiIds);
      await sincronizzaFasiDaRighe(supabase, praticaId, pratica.righe, fasiIds);
    } catch (err: any) {
      righeErrore++;
      await supabase.from("importazioni_csv_errori").insert({
        importazione_id: importazione.id,
        messaggio_errore: String(err?.message || err),
        dato_grezzo: pratica,
      });
    }
  }

  for (const e of erroriParsing) {
    await supabase.from("importazioni_csv_errori").insert({
      importazione_id: importazione.id,
      numero_riga: e.numero_riga,
      messaggio_errore: e.messaggio,
      dato_grezzo: e.dato_grezzo,
    });
  }

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
 *  pratiche in realta' gia' avanzate da tempo). Identico al CLI. */
async function completaFasiPregresse(supabase: any, praticaId: string, righe: any[], fasiIds: Record<string, string>) {
  const almenoUnaOrdinata = righe.some((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  if (!almenoUnaOrdinata) return;

  const { data: fasiPregresse } = await supabase
    .from("pratica_fasi")
    .select("id")
    .eq("pratica_id", praticaId)
    .in("fase_id", [fasiIds.ricezione, fasiIds.presa_in_carico, fasiIds.apertura_pratica, fasiIds.creazione_commissione])
    .neq("stato", "completata");

  if (!fasiPregresse || fasiPregresse.length === 0) return;

  await supabase
    .from("pratica_fasi")
    .update({
      stato: "completata",
      data_effettiva: new Date().toISOString(),
      note: "Completata automaticamente: risulta gia' un ordine piazzato su Vamart (Piano di Carico), la fase e' evidentemente gia' avvenuta.",
    })
    .in("id", fasiPregresse.map((f: any) => f.id));
}

/** Fa avanzare "Invio ordine ricambi" / "Arrivo merce in deposito" /
 *  "Consegna materiale" in base allo stato aggregato delle righe. Identico
 *  al CLI, incluso il blocco umano: "arrivo_merce" non avanza mai finche'
 *  l'operatore non dichiara a mano "conferma_ordine" sulla pratica. */
async function sincronizzaFasiDaRighe(supabase: any, praticaId: string, righe: any[], fasiIds: Record<string, string>) {
  if (!righe || righe.length === 0) return;

  const tutteOrdinate = righe.every((r) => STATI_ORDINATO_O_OLTRE.has(r.status));
  const tutteArrivate = righe.every((r) => STATI_ARRIVATO_O_OLTRE.has(r.status));
  const tutteConsegnate = righe.every((r) => r.status === "Consegnato");

  const { data: fasiAttuali } = await supabase
    .from("pratica_fasi")
    .select("id, fase_id, stato")
    .eq("pratica_id", praticaId)
    .in("fase_id", [fasiIds.ordine_ricambi, fasiIds.conferma_ordine, fasiIds.arrivo_merce, fasiIds.consegna_materiale]);

  const perFase: Record<string, any> = Object.fromEntries((fasiAttuali ?? []).map((f: any) => [f.fase_id, f]));

  const faseConfermaOrdine = perFase[fasiIds.conferma_ordine];
  if (tutteOrdinate && faseConfermaOrdine && faseConfermaOrdine.stato === "da_iniziare") {
    await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseConfermaOrdine.id);
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
    const faseCorrente = perFase[passaggio.faseId];
    if (!faseCorrente || faseCorrente.stato === "completata" || !passaggio.condizione) continue;

    await supabase
      .from("pratica_fasi")
      .update({ stato: "completata", data_effettiva: new Date().toISOString(), note: passaggio.nota })
      .eq("id", faseCorrente.id);

    const prossimoPassaggio = passaggi[indice + 1];
    if (prossimoPassaggio) {
      const faseSuccessiva = perFase[prossimoPassaggio.faseId];
      if (faseSuccessiva && faseSuccessiva.stato === "da_iniziare") {
        await supabase.from("pratica_fasi").update({ stato: "in_corso" }).eq("id", faseSuccessiva.id);
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
