// lib/import/eseguiImportazioneCommissioni.ts
// Porting in TypeScript di scripts/import-csv/importCommissioniAssistenza.mjs
// per l'uso da Route Handler (upload manuale "Commissioni" dal pannello
// admin), stessa identica logica di business del CLI usato dallo scraper:
// vedi i commenti in quel file per il dettaglio dei due casi gestiti
// (ricollegamento a segnalazione via mail, oppure apertura diretta su
// Vamart). Duplicata qui per lo stesso motivo di eseguiImportazione.ts
// (CLI e Route Handler non condividono ancora un package comune).
import { leggiCsvCommissioniDaTesto, parseDataItaliana, type RigaCommissioneGrezza } from "./parseCsvCommissioniTesto";

// Stessa finestra di tolleranza del CLI: vedi importCommissioniAssistenza.mjs.
const FINESTRA_GIORNI_MATCH = 20;

export type RisultatoImportazioneCommissioni = {
  importazioneId: string;
  righeTotali: number;
  nuove: number;
  ricollegate: number;
  giaPresenti: number;
  errori: number;
  stato: "completata" | "completata_con_errori";
};

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

  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice")
    .in("codice", ["ricezione", "presa_in_carico", "apertura_pratica", "creazione_commissione", "ordine_ricambi"]);
  if (erroreFasi) throw erroreFasi;
  const fasiIds: Record<string, string> = Object.fromEntries((fasiWorkflow ?? []).map((f: any) => [f.codice, f.id]));
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
  let giaPresenti = 0;
  let errori = 0;

  for (const riga of righe) {
    try {
      if (!riga.idCommissione || !riga.idCommissione.trim()) {
        throw new Error("Riga senza 'Id commissione', scartata");
      }
      const codiceCommissione = riga.idCommissione.trim();

      const { data: praticaEsistente } = await supabase
        .from("pratiche")
        .select("id")
        .eq("brand_id", brandId)
        .eq("codice_commissione", codiceCommissione)
        .maybeSingle();

      if (praticaEsistente) {
        giaPresenti++;
        continue;
      }

      const nomeCompleto = [riga.nome, riga.cognome].filter(Boolean).join(" ").trim() || "Cliente sconosciuto";
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
      righe_aggiornate: ricollegate,
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
    giaPresenti,
    errori,
    stato: statoFinale,
  };
}
