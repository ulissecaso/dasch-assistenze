// lib/import/eseguiImportazioneCommissioni.ts
// Porting in TypeScript di scripts/import-csv/importCommissioniAssistenza.mjs
// per l'uso da Route Handler (upload manuale "Commissioni" dal pannello
// admin), stessa identica logica di business del CLI usato dallo scraper:
// vedi i commenti in quel file per il dettaglio dei tre casi gestiti
// (ricollegamento a segnalazione via mail, apertura diretta su Vamart,
// riclassificazione di una pratica gia' tracciata come 'consegna'). Duplicata
// qui per lo stesso motivo di eseguiImportazione.ts (CLI e Route Handler non
// condividono ancora un package comune) — tenere allineata a mano quando si
// modifica la versione CLI.
import { leggiCsvCommissioniDaTesto, parseDataItaliana, type RigaCommissioneGrezza } from "./parseCsvCommissioniTesto";

// Stessa finestra di tolleranza del CLI: vedi importCommissioniAssistenza.mjs.
const FINESTRA_GIORNI_MATCH = 20;

// Store di Roma: vedi commento su VENDITORI_ESCLUSI_CINQUEGRANA in
// importCommissioniAssistenza.mjs (CLI), tenuto allineato a mano qui.
const VENDITORI_ESCLUSI_CINQUEGRANA = ["martina facchini", "iebba noemi"];

function venditoreEscluso(venditore: string | null | undefined): boolean {
  if (!venditore) return false;
  return VENDITORI_ESCLUSI_CINQUEGRANA.includes(String(venditore).trim().toLowerCase());
}

export type RisultatoImportazioneCommissioni = {
  importazioneId: string;
  righeTotali: number;
  nuove: number;
  ricollegate: number;
  riclassificate: number;
  giaPresenti: number;
  escluse: number;
  errori: number;
  stato: "completata" | "completata_con_errori";
};

type FaseWorkflowAssistenza = {
  id: string;
  codice: string;
  ordine: number;
  sla_ore_default: number | null;
  avvio_immediato: boolean;
};

// Riclassifica una pratica esistente (creata come 'consegna' dal Piano di
// Carico prima che risultasse essere una commissione di assistenza) al tipo
// 'assistenza'. Il trigger DB trg_fn_inizializza_fasi_pratica crea le
// pratica_fasi corrette solo all'INSERT della pratica: qui la pratica gia'
// esiste, quindi ricostruiamo manualmente lo stesso risultato che avrebbe
// prodotto un insert con tipo='assistenza' fin dall'inizio. Stessa logica di
// riclassificaAdAssistenza in importCommissioniAssistenza.mjs.
async function riclassificaAdAssistenza(
  supabase: any,
  praticaEsistente: { id: string; tipo: string; cliente_id: string },
  codiceCommissione: string,
  fasiAssistenza: FaseWorkflowAssistenza[]
) {
  const praticaId = praticaEsistente.id;
  const tipoPrecedente = praticaEsistente.tipo;

  const { error: erroreTipo } = await supabase.from("pratiche").update({ tipo: "assistenza" }).eq("id", praticaId);
  if (erroreTipo) throw erroreTipo;

  const { data: fasiAttuali, error: erroreFasiAttuali } = await supabase
    .from("pratica_fasi")
    .select("id, fasi_workflow!inner(tipo_pratica)")
    .eq("pratica_id", praticaId);
  if (erroreFasiAttuali) throw erroreFasiAttuali;
  const idsDaRimuovere = (fasiAttuali ?? [])
    .filter((f: any) => f.fasi_workflow?.tipo_pratica !== "assistenza")
    .map((f: any) => f.id);
  if (idsDaRimuovere.length > 0) {
    const { error: erroreRimozione } = await supabase.from("pratica_fasi").delete().in("id", idsDaRimuovere);
    if (erroreRimozione) throw erroreRimozione;
  }

  const nuoveFasi = fasiAssistenza.map((f) => ({
    pratica_id: praticaId,
    fase_id: f.id,
    stato: f.avvio_immediato ? "in_corso" : "da_iniziare",
    data_prevista: new Date(Date.now() + (f.sla_ore_default ?? 24) * 3_600_000).toISOString(),
  }));
  const { error: erroreInserimentoFasi } = await supabase.from("pratica_fasi").insert(nuoveFasi);
  if (erroreInserimentoFasi) throw erroreInserimentoFasi;

  const nomeFase = (codice: string) => fasiAssistenza.find((f) => f.codice === codice)?.id;
  const { error: erroreCompletamento } = await supabase
    .from("pratica_fasi")
    .update({
      stato: "completata",
      data_effettiva: new Date().toISOString(),
      note: `Completata automaticamente: pratica riclassificata da 'consegna' ad 'assistenza' (la commissione ${codiceCommissione} risulta ora nel CSV Commissioni di assistenza).`,
    })
    .eq("pratica_id", praticaId)
    .in("fase_id", [nomeFase("ricezione"), nomeFase("apertura_pratica"), nomeFase("creazione_commissione")].filter(Boolean));
  if (erroreCompletamento) throw erroreCompletamento;

  const { error: errorePresaInCarico } = await supabase
    .from("pratica_fasi")
    .update({ stato: "in_corso" })
    .eq("pratica_id", praticaId)
    .eq("fase_id", nomeFase("presa_in_carico"));
  if (errorePresaInCarico) throw errorePresaInCarico;

  await supabase.from("storico_modifiche").insert({
    entita: "pratiche",
    entita_id: praticaId,
    campo: "tipo",
    valore_precedente: tipoPrecedente,
    valore_nuovo: "assistenza",
    origine: "automazione",
  });

  // Le regole di assegnazione operatore sono separate tra assistenza e
  // consegna: senza questo passaggio la pratica resterebbe assegnata a chi
  // gestisce le consegne.
  const { data: cliente } = await supabase.from("clienti").select("nome_completo").eq("id", praticaEsistente.cliente_id).maybeSingle();
  if (cliente?.nome_completo) {
    const { data: nuovoOperatoreId } = await supabase.rpc("assegna_operatore_automatico", {
      p_cliente_nome: cliente.nome_completo,
      p_tipo_pratica: "assistenza",
    });
    if (nuovoOperatoreId) {
      await supabase.from("pratiche").update({ operatore_assegnato_id: nuovoOperatoreId }).eq("id", praticaId);
    }
  }
}

export async function eseguiImportazioneCommissioniCsv(
  supabase: any,
  testoCsv: string,
  opzioni: { nomeFile: string; brandCodice?: string }
): Promise<RisultatoImportazioneCommissioni> {
  const brandCodice = opzioni.brandCodice ?? "CINQUEGRANA";

  const { data: brand, error: erroreBrand } = await supabase
    .from("brands")
    .select("id, nome")
    .eq("codice", brandCodice)
    .maybeSingle();
  if (erroreBrand) throw erroreBrand;
  if (!brand) throw new Error(`Brand '${brandCodice}' non trovato in brands (migrazione 0011_multi_brand.sql applicata?)`);
  const brandId = brand.id as string;

  // Tutte le fasi attive del workflow "assistenza", non solo il sottoinsieme
  // che questo import tocca direttamente: servono tutte anche a
  // riclassificaAdAssistenza per ricostruire da zero le pratica_fasi di una
  // pratica che era stata creata (erroneamente) come 'consegna'.
  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice, ordine, sla_ore_default, avvio_immediato")
    .eq("tipo_pratica", "assistenza")
    .eq("attiva", true)
    .order("ordine", { ascending: true });
  if (erroreFasi) throw erroreFasi;
  const fasiAssistenza: FaseWorkflowAssistenza[] = fasiWorkflow ?? [];
  const fasiIds: Record<string, string> = Object.fromEntries(fasiAssistenza.map((f) => [f.codice, f.id]));
  const faseCreazioneCommissioneId = fasiIds.creazione_commissione;
  const faseOrdineRicambiId = fasiIds.ordine_ricambi;
  if (!faseCreazioneCommissioneId || !faseOrdineRicambiId || !fasiIds.ricezione || !fasiIds.presa_in_carico || !fasiIds.apertura_pratica) {
    throw new Error("Fasi richieste non trovate in fasi_workflow");
  }

  const righe: RigaCommissioneGrezza[] = leggiCsvCommissioniDaTesto(testoCsv);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: opzioni.nomeFile,
      origine: "manuale",
      righe_totali: righe.length,
      stato: "in_corso",
      brand_id: brandId,
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  let nuove = 0;
  let ricollegate = 0;
  let riclassificate = 0;
  let giaPresenti = 0;
  let escluse = 0;
  let errori = 0;

  for (const riga of righe) {
    try {
      if (!riga.idCommissione || !riga.idCommissione.trim()) {
        throw new Error("Riga senza 'Id commissione', scartata");
      }
      const codiceCommissione = riga.idCommissione.trim();

      // Store di Roma: non creiamo/aggiorniamo nessuna pratica per queste
      // righe (vedi commento su VENDITORI_ESCLUSI_CINQUEGRANA piu' sopra).
      if (brandCodice === "CINQUEGRANA" && venditoreEscluso(riga.venditore)) {
        escluse++;
        continue;
      }

      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("id, tipo, cliente_id")
        .eq("brand_id", brandId)
        .eq("codice_commissione", codiceCommissione)
        .maybeSingle();

      if (praticaEsistente) {
        if (praticaEsistente.tipo === "assistenza") {
          giaPresenti++;
          continue;
        }
        // Tipo diverso da 'assistenza' (praticamente sempre 'consegna'): la
        // pratica era stata importata dal Piano di Carico prima di sapere
        // che era una commissione di assistenza. La riclassifichiamo invece
        // di ignorarla, altrimenti resterebbe visibile nel Monitor Consegne
        // come se fosse una commissione normale.
        await riclassificaAdAssistenza(supabase, praticaEsistente, codiceCommissione, fasiAssistenza);
        riclassificate++;
        continue;
      }

      // Ordine Cognome-Nome, non Nome-Cognome: e' la convenzione usata in
      // tutto il resto del sistema (dato Vamart del Piano di Carico, e la
      // funzione assegna_operatore_automatico che legge la prima lettera
      // della prima parola come iniziale del COGNOME). Prima qui l'ordine
      // era invertito: i clienti creati da questo importatore finivano
      // assegnati in base all'iniziale del nome proprio invece che del
      // cognome, capitando quindi all'operatore sbagliato.
      const nomeCompleto = [riga.cognome, riga.nome].filter(Boolean).join(" ").trim() || "Cliente sconosciuto";
      const dataRegistrazione = parseDataItaliana(riga.dataRegistrazione || "");

      const { data: clientiOmonimi } = await supabase
        .from("clienti")
        .select("id")
        .eq("brand_id", brandId)
        .ilike("nome_completo", nomeCompleto);

      let candidati: any[] = [];
      if (clientiOmonimi && clientiOmonimi.length > 0) {
        const idsClienti = clientiOmonimi.map((c: any) => c.id);
        const { data: pratichePendenti } = await supabase
          .from("pratiche")
          .select("id, data_apertura, pratica_fasi!inner(id, stato, fase_id)")
          .eq("brand_id", brandId)
          .in("cliente_id", idsClienti)
          .not("stato_generale", "in", "(chiusa,annullata)")
          .eq("pratica_fasi.fase_id", faseCreazioneCommissioneId)
          .neq("pratica_fasi.stato", "completata");

        candidati = (pratichePendenti ?? []).filter((p: any) => {
          if (!dataRegistrazione || !p.data_apertura) return true;
          const giorni = Math.abs((new Date(dataRegistrazione).getTime() - new Date(p.data_apertura).getTime()) / 86400000);
          return giorni <= FINESTRA_GIORNI_MATCH;
        });
      }

      if (candidati.length === 1) {
        const pratica = candidati[0];
        const faseCreazione = pratica.pratica_fasi[0];

        await supabase
          .from("pratica_fasi")
          .update({
            stato: "completata",
            data_effettiva: new Date().toISOString(),
            note: `Commissione di assistenza creata su Vamart: ${codiceCommissione} (importazione manuale dal pannello admin).`,
          })
          .eq("id", faseCreazione.id);

        await supabase
          .from("pratica_fasi")
          .update({ stato: "in_corso" })
          .eq("pratica_id", pratica.id)
          .eq("fase_id", faseOrdineRicambiId)
          .eq("stato", "da_iniziare");

        await supabase.from("storico_modifiche").insert({
          entita: "pratiche",
          entita_id: pratica.id,
          campo: "creazione_commissione",
          valore_precedente: null,
          valore_nuovo: codiceCommissione,
          origine: "importazione_csv",
        });

        ricollegate++;
        continue;
      }

      if (candidati.length > 1) {
        throw new Error(
          `Trovate ${candidati.length} pratiche in attesa per "${nomeCompleto}" nella stessa finestra di date: collegamento ambiguo, serve verifica manuale.`
        );
      }

      const { data: clienteEsistente } = await supabase
        .from("clienti")
        .select("id")
        .eq("brand_id", brandId)
        .ilike("nome_completo", nomeCompleto)
        .maybeSingle();

      let clienteId = clienteEsistente?.id;
      if (!clienteId) {
        const { data: nuovoCliente, error } = await supabase
          .from("clienti")
          .insert({ nome_completo: nomeCompleto, citta: riga.citta || null, brand_id: brandId })
          .select()
          .single();
        if (error) throw error;
        clienteId = nuovoCliente.id;
      }

      const dettagliParti = ["Commissione di assistenza aperta direttamente su Vamart (nessuna segnalazione via mail collegabile)."];
      if (riga.idPreventivo) dettagliParti.push(`Preventivo: ${riga.idPreventivo}.`);
      if (riga.venditore) dettagliParti.push(`Venditore: ${riga.venditore}.`);
      if (riga.importo) dettagliParti.push(`Importo: ${riga.importo}.`);

      const { data: nuovaPratica, error: erroreInserimento } = await supabase
        .from("pratiche")
        .insert({
          codice_commissione: codiceCommissione,
          codice_commissione_riferimento: codiceCommissione,
          cliente_id: clienteId,
          brand_id: brandId,
          tipo: "assistenza",
          canale_origine: "manuale",
          fonte_dati: "csv",
          stato_generale: "aperta",
          data_apertura: dataRegistrazione || new Date().toISOString(),
          data_consegna_prevista: parseDataItaliana(riga.dataConsegna || ""),
          descrizione: dettagliParti.join(" "),
        })
        .select()
        .single();
      if (erroreInserimento) throw erroreInserimento;

      await supabase
        .from("pratica_fasi")
        .update({ stato: "completata", data_effettiva: new Date().toISOString(), note: "Completata automaticamente: pratica proveniente da Vamart, non da segnalazione mail." })
        .eq("pratica_id", nuovaPratica.id)
        .in("fase_id", [fasiIds.ricezione, fasiIds.apertura_pratica, faseCreazioneCommissioneId]);

      await supabase
        .from("pratica_fasi")
        .update({ stato: "in_corso" })
        .eq("pratica_id", nuovaPratica.id)
        .eq("fase_id", fasiIds.presa_in_carico);

      nuove++;
    } catch (err: any) {
      errori++;
      await supabase.from("importazioni_csv_errori").insert({
        importazione_id: importazione.id,
        numero_riga: riga._numeroRiga,
        messaggio_errore: String(err?.message || err),
        dato_grezzo: riga._grezzo,
      });
    }
  }

  const statoFinale: "completata" | "completata_con_errori" = errori > 0 ? "completata_con_errori" : "completata";

  await supabase
    .from("importazioni_csv")
    .update({
      righe_nuove: nuove,
      // righe_aggiornate raccoglie sia le pratiche ricollegate a una
      // segnalazione via mail sia quelle riclassificate da 'consegna' ad
      // 'assistenza': in entrambi i casi una pratica esistente e' stata
      // modificata (non c'e' una colonna dedicata in importazioni_csv).
      righe_aggiornate: ricollegate + riclassificate,
      righe_invariate: giaPresenti,
      righe_errore: errori,
      stato: statoFinale,
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  return {
    importazioneId: importazione.id,
    righeTotali: righe.length,
    nuove,
    ricollegate,
    riclassificate,
    giaPresenti,
    escluse,
    errori,
    stato: statoFinale,
  };
}
