// lib/monitor/caricaDatiConsegne.ts
// Query condivisa dai due punti che mostrano il "Monitor Consegne" vista
// ufficio: la Dashboard Direzione Consegne autenticata
// (/dashboard-direzione-consegne) e il link pubblico di sola visualizzazione
// per il monitor a parete (/monitor/consegne). Stessa idea di
// caricaDatiDirezione.ts (assistenza), ma con due differenze di logica
// proprie del modulo Consegne:
//  1. Le fasi monitorate sono "pianificazione_consegna" e "pagamento", e
//     diventano "in_corso" (quindi alert vero e proprio) solo quando tutta
//     la merce risulta arrivata in deposito (100%) — vedi
//     sincronizzaFasiConsegna in scripts/import-csv/importVamartCsv.mjs.
//  2. Prima di arrivare al 100%, se la merce e' arrivata almeno all'80% e'
//     comunque utile un avviso (valutare consegna parziale o sollecitare il
//     fornitore): non essendo una vera "fase in ritardo" (pianificazione
//     consegna e' ancora "da_iniziare"), questo avviso viene costruito a
//     parte incrociando v_percentuale_merce_arrivata sulle pratiche di
//     consegna ancora aperte, e mostrato con livello fisso "media".
import type { AlertRigaMonitor, OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, coloreOperatore, formattaScadenza, costruisciMappaRegole, calcolaLivelloDaRitardo } from "@/lib/monitor/mappature";
import { caricaAvvisiImportazione } from "@/lib/monitor/caricaAvvisiImportazione";

const FASI_CONSEGNA = ["pianificazione_consegna", "pagamento"];
const SOGLIA_CONSEGNA_PARZIALE = 80;

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

// Vedi commento in caricaDatiDirezione.ts: stessa logica di filtro brand,
// duplicata qui per lo stesso motivo per cui il resto del file e' duplicato
// (query dedicate al modulo Consegne).
type OpzioniFiltroBrand = { escludiBrandCodici?: string[]; soloBrandCodici?: string[] };

async function risolviIdBrand(supabase: any, codici: string[]): Promise<string[]> {
  if (!codici || codici.length === 0) return [];
  const { data } = await supabase.from("brands").select("id").in("codice", codici);
  return (data ?? []).map((b: any) => b.id);
}

export async function caricaDatiConsegne(supabase: any, opzioni: OpzioniFiltroBrand = {}) {
  const adessoMs = Date.now();
  const oggi = oggiIso();

  const [idEsclusi, idSolo] = await Promise.all([
    risolviIdBrand(supabase, opzioni.escludiBrandCodici ?? []),
    risolviIdBrand(supabase, opzioni.soloBrandCodici ?? []),
  ]);
  const listaSql = (ids: string[]) => `(${ids.join(",")})`;
  const conFiltroBrand = (query: any, campo: string) => {
    if (idSolo.length > 0) return query.in(campo, idSolo);
    if (idEsclusi.length > 0) return query.not(campo, "in", listaSql(idEsclusi));
    return query;
  };

  const [
    { data: operatoriRegoleGrezze },
    { data: faseConteggio },
    { data: faseTabella },
    { data: praticheConsegnaAperte },
    { count: praticheTotali },
    { count: risoltiOggi },
    { data: regoleAttive },
  ] = await Promise.all([
    // Solo gli operatori con almeno una regola di assegnazione attiva per le
    // consegne compaiono nelle card: a differenza del monitor assistenza,
    // qui l'elenco e' specifico per questo modulo (oggi Francesca e Lucia).
    // Il brand_id della regola viene filtrato in JS piu' sotto.
    supabase
      .from("regole_assegnazione")
      .select("brand_id, utenti:operatore_id(id, nome, cognome, colore_badge)")
      .eq("tipo_pratica", "consegna")
      .eq("attiva", true),
    // Conteggio (per le card operatore e le statistiche): fasi consegna
    // "in_corso", senza limite di righe (vedi stesso motivo spiegato in
    // caricaDatiDirezione.ts per la versione assistenza).
    conFiltroBrand(
      supabase
        .from("pratica_fasi")
        .select(`
        id, data_prevista, fase_id,
        fasi_workflow!inner(codice),
        pratiche!inner(id, stato_generale, operatore_assegnato_id, tipo, brand_id)
      `)
        .eq("stato", "in_corso")
        .eq("pratiche.tipo", "consegna")
        .in("fasi_workflow.codice", FASI_CONSEGNA),
      "pratiche.brand_id"
    ).limit(5000),
    // Tabella: stesse righe con i dati da mostrare, ordinate.
    conFiltroBrand(
      supabase
        .from("pratica_fasi")
        .select(`
        id, stato, data_prevista, fase_id,
        fasi_workflow!inner(codice, nome),
        pratiche!inner(id, codice_commissione, stato_generale, operatore_assegnato_id, tipo, brand_id,
          clienti(nome_completo),
          utenti:operatore_assegnato_id(id, nome, cognome, colore_badge),
          brands(codice, nome, colore)
        )
      `)
        .eq("stato", "in_corso")
        .eq("pratiche.tipo", "consegna")
        .in("fasi_workflow.codice", FASI_CONSEGNA)
        .order("data_prevista", { ascending: true }),
      "pratiche.brand_id"
    ).limit(300),
    // Tutte le pratiche di consegna ancora aperte: servono per l'avviso
    // "merce parzialmente arrivata" (incrociate con la vista qui sotto).
    conFiltroBrand(
      supabase
        .from("pratiche")
        .select("id, codice_commissione, operatore_assegnato_id, data_consegna_prevista, brand_id, clienti(nome_completo), utenti:operatore_assegnato_id(id, nome, cognome, colore_badge), brands(codice, nome, colore)")
        .eq("tipo", "consegna")
        .not("stato_generale", "in", '("chiusa","annullata")'),
      "brand_id"
    ),
    conFiltroBrand(
      supabase.from("pratiche").select("*", { count: "exact", head: true }).eq("tipo", "consegna").not("stato_generale", "in", '("chiusa","annullata")'),
      "brand_id"
    ),
    conFiltroBrand(
      supabase.from("pratiche").select("*", { count: "exact", head: true }).eq("tipo", "consegna").eq("stato_generale", "chiusa").gte("data_chiusura_effettiva", `${oggi}T00:00:00Z`),
      "brand_id"
    ),
    supabase.from("regole_alert").select("fase_id, soglia_valore, soglia_unita, livello").eq("attiva", true),
  ]);

  const operatoriRegole = (operatoriRegoleGrezze ?? []).filter((r: any) => {
    if (idSolo.length > 0) return r.brand_id && idSolo.includes(r.brand_id);
    if (idEsclusi.length > 0) return !r.brand_id || !idEsclusi.includes(r.brand_id);
    return true;
  });

  const regolePerFase = costruisciMappaRegole(regoleAttive);

  const conLivello = (righe: any[] | null | undefined) =>
    (righe ?? [])
      .filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale))
      .map((r: any) => {
        const oreRitardo = (adessoMs - new Date(r.data_prevista).getTime()) / 3_600_000;
        return { ...r, livello: calcolaLivelloDaRitardo(regolePerFase, r.fase_id, oreRitardo) };
      });

  const righeConLivelloConteggio = conLivello(faseConteggio);
  const righeConLivelloTabella = conLivello(faseTabella);

  // Pratiche gia' in "pianificazione_consegna: in_corso" (100% arrivato):
  // per queste l'avviso parziale non serve piu', c'e' gia' la riga vera.
  const idGiaInCorso = new Set(
    righeConLivelloTabella
      .filter((r: any) => r.fasi_workflow?.codice === "pianificazione_consegna")
      .map((r: any) => r.pratiche.id)
  );
  const idDaControllare = (praticheConsegnaAperte ?? [])
    .filter((p: any) => !idGiaInCorso.has(p.id))
    .map((p: any) => p.id);

  const mappaPercentuale = new Map<string, number>();
  if (idDaControllare.length > 0) {
    const { data: percentuali } = await supabase
      .from("v_percentuale_merce_arrivata")
      .select("pratica_id, percentuale_arrivata")
      .in("pratica_id", idDaControllare);
    for (const p of percentuali ?? []) mappaPercentuale.set(p.pratica_id, p.percentuale_arrivata);
  }

  const mappaOperatorePerPratica = new Map<string, string | null>();
  for (const p of praticheConsegnaAperte ?? []) mappaOperatorePerPratica.set(p.id, p.operatore_assegnato_id);

  const righeAvvisoParziale: AlertRigaMonitor[] = (praticheConsegnaAperte ?? [])
    .filter((p: any) => {
      const perc = mappaPercentuale.get(p.id);
      return perc != null && perc >= SOGLIA_CONSEGNA_PARZIALE && perc < 100;
    })
    .map((p: any) => {
      const perc = mappaPercentuale.get(p.id)!;
      const opNome = p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato";
      const opColore = p.utenti ? coloreOperatore(p.utenti.id, p.utenti.colore_badge) : "#6b7280";
      const { data, ora } = p.data_consegna_prevista ? formattaScadenza(p.data_consegna_prevista) : { data: "-", ora: "-" };
      return {
        id: `parziale-${p.id}`,
        livello: "media" as const,
        scadenzaData: data,
        scadenzaOra: ora,
        praticaId: p.id,
        praticaCodice: p.codice_commissione,
        cliente: p.clienti?.nome_completo ?? "—",
        faseNome: "Merce in arrivo",
        faseIcona: "box",
        descrizione: `Merce parzialmente pronta in deposito (${perc}%)`,
        operatoreNome: opNome,
        operatoreColore: opColore,
        azione: "Valutare consegna parziale o sollecitare il fornitore",
        brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
      };
    });

  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;

  const righeSla: AlertRigaMonitor[] = righeConLivelloTabella.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    const { data, ora } = formattaScadenza(r.data_prevista);
    const opNome = p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato";
    const opColore = p.utenti ? coloreOperatore(p.utenti.id, p.utenti.colore_badge) : "#6b7280";
    return {
      id: r.id,
      livello: r.livello,
      scadenzaData: data,
      scadenzaOra: ora,
      praticaId: p.id,
      praticaCodice: p.codice_commissione,
      cliente: p.clienti?.nome_completo ?? "—",
      faseNome: fw?.nome ?? "Fase",
      faseIcona: ICONA_PER_FASE[fw?.codice] ?? "warn-sm",
      descrizione: `${fw?.nome ?? "Fase"} da dichiarare`,
      operatoreNome: opNome,
      operatoreColore: opColore,
      azione: AZIONE_PER_FASE[fw?.codice] ?? "Verificare fase",
      brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
    };
  });

  const alertRows = [...righeSla, ...righeAvvisoParziale].sort((a, b) => {
    const rangoA = RANGO_LIVELLO[a.livello];
    const rangoB = RANGO_LIVELLO[b.livello];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return `${a.scadenzaData} ${a.scadenzaOra}`.localeCompare(`${b.scadenzaData} ${b.scadenzaOra}`);
  });

  // Elenco operatori del modulo Consegne (deduplicato), dalle regole di
  // assegnazione attive con tipo_pratica = 'consegna'.
  const operatoriConsegna = Array.from(
    new Map(
      (operatoriRegole ?? [])
        .filter((r: any) => r.utenti)
        .map((r: any) => [r.utenti.id, r.utenti])
    ).values()
  ) as { id: string; nome: string; cognome: string; colore_badge: string | null }[];

  const operatori: OperatoreCardMonitor[] = operatoriConsegna
    .sort((a, b) => a.nome.localeCompare(b.nome))
    .map((op) => {
      const alertSla = righeConLivelloConteggio.filter((r: any) => r.pratiche.operatore_assegnato_id === op.id);
      const alertParziali = righeAvvisoParziale.filter((r) => mappaOperatorePerPratica.get(r.praticaId) === op.id);
      return {
        id: op.id,
        nome: `${op.nome} ${op.cognome}`,
        colore: coloreOperatore(op.id, op.colore_badge),
        alertAttivi: alertSla.length + alertParziali.length,
        urgenti: alertSla.filter((r: any) => r.livello === "critica").length,
      };
    });

  // "Scaduti" e "in scadenza oggi" restano legati alle sole soglie SLA vere e
  // proprie (pianificazione_consegna/pagamento in_corso): l'avviso di merce
  // parziale non ha una vera scadenza SLA, e' solo un suggerimento operativo.
  const scaduti = righeConLivelloConteggio.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righeConLivelloConteggio.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

  // Avvisi su problemi di alimentazione dati (import CSV Vamart o email di
  // segnalazione): uguali per Assistenza e Consegne, e' la stessa fonte dati
  // per entrambi i moduli - vedi lib/monitor/caricaAvvisiImportazione.ts.
  const avvisiImportazione = await caricaAvvisiImportazione(supabase);

  return {
    alertRows,
    operatori,
    stats: {
      allertTotali: righeConLivelloConteggio.length + righeAvvisoParziale.length,
      allertUrgenti: righeConLivelloConteggio.filter((r: any) => r.livello === "critica").length,
      scaduti,
      inScadenzaOggi,
      risoltiOggi: risoltiOggi ?? 0,
      praticheTotali: praticheTotali ?? 0,
    },
    avvisiImportazione,
  };
}
