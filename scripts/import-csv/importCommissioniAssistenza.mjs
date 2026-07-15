// importCommissioniAssistenza.mjs
// Importatore CSV "Commissioni" (pagina Commissioni di Vamart, filtro
// "Commissioni Assistenza" = "Solo di assistenza") -> Supabase.
//
// Le commissioni di assistenza su Vamart nascono in due modi diversi, e
// questo script li gestisce entrambi:
//
//  1) Il cliente segnala un problema via app/sito -> arriva la mail -> il
//     sistema crea gia' una pratica "in attesa" (fase 'creazione_commissione'
//     non ancora completata). Quando l'operatore va su Vamart e crea li' la
//     commissione di assistenza vera, Vamart le assegna un NUMERO NUOVO,
//     diverso da quello che il cliente aveva citato nella mail: non possiamo
//     quindi riconoscerla per codice_commissione. La colleghiamo per nome
//     cliente + vicinanza di data alla pratica "in attesa" corrispondente, e
//     chiudiamo automaticamente la fase (cosi' il countdown SLA si ferma).
//     Se l'operatore NON la crea in tempo, la fase resta aperta e il motore
//     di alert gia' esistente (soglie 24h/48h/escalation) segnala il ritardo.
//
//  2) Il venditore crea direttamente una commissione di assistenza su Vamart,
//     senza che sia mai arrivata una mail dal cliente. In questo caso non
//     esiste nessuna pratica "in attesa" da collegare: ne creiamo una nuova
//     "grezza", cosi' l'operatore la vede e deve comunque prenderla in carico.
//
// Se per lo stesso cliente risultano PIU' pratiche in attesa nella stessa
// finestra di date (caso ambiguo), non indoviniamo: la riga viene segnalata
// come errore in importazioni_csv_errori per una verifica manuale.
//
//  3) La commissione risulta gia' tracciata, ma con tipo diverso da
//     'assistenza' (in pratica: 'consegna'). Succede quando
//     importVamartCsv.mjs (Piano di Carico) l'ha importata per prima,
//     senza ancora sapere che si trattava di una commissione di assistenza
//     (es. upload manuale dal pannello admin del solo Piano di Carico,
//     formato che oggi e' l'unico supportato in UI, oppure un ordine di
//     esecuzione invertito). In questo caso la riclassifichiamo ad
//     assistenza (tipo, fasi, storico) invece di ignorarla: altrimenti
//     resterebbe visibile nel Monitor Consegne come se fosse una
//     commissione normale, mentre in Monitor Assistenza non comparirebbe
//     mai. Vedi riclassificaAdAssistenza più sotto.
//
// Uso:
//   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node importCommissioniAssistenza.mjs "/percorso/commissioni.csv"
//   (opzionale) BRAND_CODICE=MASTERMOBILI ... stesso principio di
//   importVamartCsv.mjs: default CINQUEGRANA, invariato rispetto a prima.

import { readFileSync } from "node:fs";
import { parse } from "csv-parse/sync";
import { createClient } from "@supabase/supabase-js";
import { parseDataItaliana } from "./parseCsv.mjs";

const PROXY_URL = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
if (PROXY_URL) {
  const { ProxyAgent, setGlobalDispatcher } = await import("undici");
  setGlobalDispatcher(new ProxyAgent(PROXY_URL));
  console.log(`Uso proxy per le richieste di rete: ${PROXY_URL}`);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BRAND_CODICE = process.env.BRAND_CODICE || "CINQUEGRANA";

// Finestra di tolleranza per collegare una commissione Vamart a una pratica
// "in attesa": la data di apertura della pratica deve cadere entro questi
// giorni PRIMA o DOPO la data di registrazione su Vamart. Copre normali
// ritardi operativi senza rischiare di agganciare casi troppo vecchi.
const FINESTRA_GIORNI_MATCH = 20;

const ALIAS_COLONNE = {
  "id commissione": "idCommissione",
  "id preventivo": "idPreventivo",
  "cognome": "cognome",
  "nome": "nome",
  "data registrazione": "dataRegistrazione",
  "data consegna": "dataConsegna",
  "importo": "importo",
  "venditore": "venditore",
  "città": "citta",
  "citta": "citta",
};

function normalizzaIntestazione(testo) {
  return String(testo || "").trim().toLowerCase();
}

// Riclassifica una pratica esistente (creata come 'consegna' dal Piano di
// Carico prima che risultasse essere una commissione di assistenza) al
// tipo 'assistenza'. Il trigger DB trg_fn_inizializza_fasi_pratica crea le
// pratica_fasi corrette solo all'INSERT della pratica: qui la pratica gia'
// esiste, quindi ricostruiamo manualmente lo stesso risultato che avrebbe
// prodotto un insert con tipo='assistenza' fin dall'inizio.
async function riclassificaAdAssistenza(supabase, praticaEsistente, codiceCommissione, fasiAssistenza) {
  const praticaId = praticaEsistente.id;
  const tipoPrecedente = praticaEsistente.tipo;

  // 1) Tipo pratica.
  const { error: erroreTipo } = await supabase.from("pratiche").update({ tipo: "assistenza" }).eq("id", praticaId);
  if (erroreTipo) throw erroreTipo;

  // 2) Rimuove le pratica_fasi del workflow sbagliato (es. "Programma
  //    consegna"/"Pagamento ricevuto" per il caso 'consegna'), create dal
  //    trigger quando la pratica era stata inserita con tipo errato.
  const { data: fasiAttuali, error: erroreFasiAttuali } = await supabase
    .from("pratica_fasi")
    .select("id, fasi_workflow!inner(tipo_pratica)")
    .eq("pratica_id", praticaId);
  if (erroreFasiAttuali) throw erroreFasiAttuali;
  const idsDaRimuovere = (fasiAttuali ?? [])
    .filter((f) => f.fasi_workflow?.tipo_pratica !== "assistenza")
    .map((f) => f.id);
  if (idsDaRimuovere.length > 0) {
    const { error: erroreRimozione } = await supabase.from("pratica_fasi").delete().in("id", idsDaRimuovere);
    if (erroreRimozione) throw erroreRimozione;
  }

  // 3) Crea le pratica_fasi del workflow "assistenza" (stessa logica di
  //    trg_fn_inizializza_fasi_pratica, replicata qui perche' il trigger
  //    non si riattiva su un semplice update del tipo).
  const nuoveFasi = fasiAssistenza.map((f) => ({
    pratica_id: praticaId,
    fase_id: f.id,
    stato: f.avvio_immediato ? "in_corso" : "da_iniziare",
    data_prevista: new Date(Date.now() + (f.sla_ore_default ?? 24) * 3_600_000).toISOString(),
  }));
  const { error: erroreInserimentoFasi } = await supabase.from("pratica_fasi").insert(nuoveFasi);
  if (erroreInserimentoFasi) throw erroreInserimentoFasi;

  // 4) La pratica esiste gia' su Vamart (aveva gia' righe/articoli dal
  //    Piano di Carico): "Ricezione", "Apertura pratica" e "Creazione
  //    commissione" sono gia' vere per definizione, stesso ragionamento
  //    della pratica "grezza" creata piu' sotto in questo stesso file. La
  //    fase attiva diventa "Presa in carico". Le fasi successive (ordine
  //    ricambi, arrivo merce, consegna) verranno sincronizzate dal
  //    prossimo giro di importVamartCsv.mjs, che ora trovera' tipo =
  //    'assistenza' e seguira' il ramo corretto.
  const nomeFase = (codice) => fasiAssistenza.find((f) => f.codice === codice)?.id;
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

  // 5) Storico, per tracciabilita' (stessa nota sul vincolo 'origine' del
  //    resto del file: e' un'automazione, non un'importazione CSV in senso
  //    stretto ne' un'azione utente).
  await supabase.from("storico_modifiche").insert({
    entita: "pratiche",
    entita_id: praticaId,
    campo: "tipo",
    valore_precedente: tipoPrecedente,
    valore_nuovo: "assistenza",
    origine: "automazione",
  });

  // 6) Le regole di assegnazione operatore sono separate tra assistenza e
  //    consegna (stessa iniziale cognome puo' avere operatori diversi nei
  //    due moduli): senza questo passaggio la pratica resterebbe assegnata
  //    a chi gestisce le consegne. Usa la stessa funzione SQL gia' in
  //    produzione (assegna_operatore_automatico), invece di duplicarne la
  //    logica qui in JS.
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

function leggiCsv(percorsoFile) {
  const contenuto = readFileSync(percorsoFile, "utf8");
  const righeGrezze = parse(contenuto, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });

  return righeGrezze.map((rigaGrezza, indice) => {
    const riga = {};
    for (const [intestazione, valore] of Object.entries(rigaGrezza)) {
      const chiave = ALIAS_COLONNE[normalizzaIntestazione(intestazione)];
      if (chiave) riga[chiave] = valore;
    }
    riga._numeroRiga = indice + 2;
    riga._grezzo = rigaGrezza;
    return riga;
  });
}

async function main() {
  const percorsoFile = process.argv[2];
  if (!percorsoFile) {
    console.error("Uso: node importCommissioniAssistenza.mjs <percorso-file-csv>");
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

  // Fasi del workflow "assistenza": tutte quelle attive, non solo il
  // sottoinsieme che questo script tocca direttamente. Servono tutte anche
  // a riclassificaAdAssistenza per ricostruire da zero le pratica_fasi di
  // una pratica che era stata creata (erroneamente) come 'consegna'.
  // Risolte per codice, non per id fisso, cosi' restano valide anche se
  // qualcuno le ricrea.
  const { data: fasiWorkflow, error: erroreFasi } = await supabase
    .from("fasi_workflow")
    .select("id, codice, ordine, sla_ore_default, avvio_immediato")
    .eq("tipo_pratica", "assistenza")
    .eq("attiva", true)
    .order("ordine", { ascending: true });
  if (erroreFasi) throw erroreFasi;
  const fasiIds = Object.fromEntries(fasiWorkflow.map((f) => [f.codice, f.id]));
  const faseCreazioneCommissioneId = fasiIds.creazione_commissione;
  const faseOrdineRicambiId = fasiIds.ordine_ricambi;
  if (!faseCreazioneCommissioneId || !faseOrdineRicambiId || !fasiIds.ricezione || !fasiIds.presa_in_carico || !fasiIds.apertura_pratica) {
    throw new Error("Fasi richieste non trovate in fasi_workflow");
  }

  console.log(`Lettura file: ${percorsoFile}`);
  const righe = leggiCsv(percorsoFile);
  console.log(`Righe lette: ${righe.length}`);

  const { data: importazione, error: erroreImport } = await supabase
    .from("importazioni_csv")
    .insert({
      nome_file: percorsoFile.split("/").pop(),
      // Valore valido per importazioni_csv.origine ('manuale' | 'scraper_automatico' | 'api').
      origine: "scraper_automatico",
      righe_totali: righe.length,
      stato: "in_corso",
      brand_id: brandId,
    })
    .select()
    .single();
  if (erroreImport) throw erroreImport;

  let nuove = 0, ricollegate = 0, giaPresenti = 0, riclassificate = 0, errori = 0;

  for (const riga of righe) {
    try {
      if (!riga.idCommissione || !riga.idCommissione.trim()) {
        throw new Error("Riga senza 'Id commissione', scartata");
      }
      const codiceCommissione = riga.idCommissione.trim();

      // Gia' tracciata (da un import precedente, con questo stesso numero)?
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
        // Tipo diverso da 'assistenza' (praticamente sempre 'consegna'):
        // vedi commento in cima al file, caso 3.
        await riclassificaAdAssistenza(supabase, praticaEsistente, codiceCommissione, fasiWorkflow);
        riclassificate++;
        continue;
      }

      const nomeCompleto = [riga.nome, riga.cognome].filter(Boolean).join(" ").trim() || "Cliente sconosciuto";
      const dataRegistrazione = parseDataItaliana(riga.dataRegistrazione);

      // Cerca una pratica "in attesa" dello stesso cliente (nata da mail,
      // fase 'creazione_commissione' non ancora completata) aperta in una
      // finestra di date ragionevole intorno a questa registrazione Vamart.
      const { data: clientiOmonimi } = await supabase
        .from("clienti")
        .select("id")
        .eq("brand_id", brandId)
        .ilike("nome_completo", nomeCompleto);

      let candidati = [];
      if (clientiOmonimi && clientiOmonimi.length > 0) {
        const idsClienti = clientiOmonimi.map((c) => c.id);
        const { data: pratichePendenti } = await supabase
          .from("pratiche")
          .select("id, data_apertura, pratica_fasi!inner(id, stato, fase_id)")
          .eq("brand_id", brandId)
          .in("cliente_id", idsClienti)
          .not("stato_generale", "in", "(chiusa,annullata)")
          .eq("pratica_fasi.fase_id", faseCreazioneCommissioneId)
          .neq("pratica_fasi.stato", "completata");

        candidati = (pratichePendenti ?? []).filter((p) => {
          if (!dataRegistrazione || !p.data_apertura) return true; // nessuna data per filtrare: teniamo come possibile candidato
          const giorni = Math.abs((new Date(dataRegistrazione) - new Date(p.data_apertura)) / 86400000);
          return giorni <= FINESTRA_GIORNI_MATCH;
        });
      }

      if (candidati.length === 1) {
        // Collegamento trovato: chiudiamo la fase "creazione_commissione" e
        // facciamo avanzare il puntatore alla fase successiva.
        const pratica = candidati[0];
        const faseCreazione = pratica.pratica_fasi[0];

        await supabase
          .from("pratica_fasi")
          .update({
            stato: "completata",
            data_effettiva: new Date().toISOString(),
            note: `Commissione di assistenza creata su Vamart: ${codiceCommissione} (rilevata dallo scraper automatico).`,
          })
          .eq("id", faseCreazione.id);

        await supabase
          .from("pratica_fasi")
          .update({ stato: "in_corso" })
          .eq("pratica_id", pratica.id)
          .eq("fase_id", faseOrdineRicambiId)
          .eq("stato", "da_iniziare");

        // origine deve essere uno tra 'utente' | 'importazione_csv' |
        // 'importazione_api' | 'automazione' (vincolo su storico_modifiche):
        // uno scraper e' un'automazione, non e' l'utente ne' un'importazione
        // CSV "manuale/Piano di Carico" in senso stretto.
        await supabase.from("storico_modifiche").insert({
          entita: "pratiche",
          entita_id: pratica.id,
          campo: "creazione_commissione",
          valore_precedente: null,
          valore_nuovo: codiceCommissione,
          origine: "automazione",
        });

        ricollegate++;
        continue;
      }

      if (candidati.length > 1) {
        throw new Error(
          `Trovate ${candidati.length} pratiche in attesa per "${nomeCompleto}" nella stessa finestra di date: collegamento ambiguo, servono verifica manuale.`
        );
      }

      // Nessuna pratica in attesa trovata: commissione di assistenza aperta
      // direttamente dal venditore su Vamart, senza segnalazione via mail.
      // Creiamo una pratica "grezza" da far prendere in carico all'operatore.
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
          data_consegna_prevista: parseDataItaliana(riga.dataConsegna),
          descrizione: dettagliParti.join(" "),
        })
        .select()
        .single();
      if (erroreInserimento) throw erroreInserimento;

      // Pratica nata direttamente da Vamart, non da segnalazione mail:
      // "Ricezione segnalazione", "Apertura pratica" e "Creazione
      // commissione" sono gia' vere per definizione (la pratica esiste
      // perche' e' gia' su Vamart). La fase attiva diventa "Presa in
      // carico", che richiede davvero un intervento dell'operatore.
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
    } catch (err) {
      errori++;
      await supabase.from("importazioni_csv_errori").insert({
        importazione_id: importazione.id,
        numero_riga: riga._numeroRiga,
        messaggio_errore: String(err.message || err),
        dato_grezzo: riga._grezzo,
      });
    }
  }

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
      stato: errori > 0 ? "completata_con_errori" : "completata",
      completata_il: new Date().toISOString(),
    })
    .eq("id", importazione.id);

  console.log(
    `Import completata. Pratiche nuove: ${nuove}, ricollegate a segnalazioni via mail: ${ricollegate}, ` +
    `riclassificate da 'consegna' ad 'assistenza': ${riclassificate}, gia' presenti: ${giaPresenti}, errori: ${errori}`
  );
}

main().catch((err) => {
  console.error("Errore fatale durante l'importazione:", err);
  process.exit(1);
});
