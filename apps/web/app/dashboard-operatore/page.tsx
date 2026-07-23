// app/dashboard-operatore/page.tsx
// Stesso "Monitor Assistenze" della dashboard direzione, ma con i dati già
// ristretti alle sole pratiche dell'operatore che ha fatto login: stessa
// resa grafica, scopo diverso (vista personale invece che vista d'ufficio).
//
// A differenza del monitor a parete (righeMax=11, pensato per uno schermo
// fisso in ufficio), qui NON limitiamo le righe: l'operatore deve poter
// scorrere con la rotella del mouse tutto il proprio elenco (anche centinaia
// di pratiche), quindi passiamo a MonitorBoard il numero vero di righe
// invece di un tetto fisso.
import { richiediUtente } from "@/lib/auth/richiediUtente";
import MonitorBoard, { type AlertRigaMonitor, type OperatoreCardMonitor } from "@/components/monitor/MonitorBoard";
import { ICONA_PER_FASE, AZIONE_PER_FASE, coloreOperatore, formattaScadenza, costruisciMappaRegole, calcolaLivelloDaRitardo, etichettaArrivoMerce, praticaEspositivaDaEscludere } from "@/lib/monitor/mappature";

export const dynamic = "force-dynamic"; // pagina protetta e specifica per utente: mai cache statica/ISR

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export default async function DashboardOperatorePage() {
  const { supabase, user } = await richiediUtente();
  const adesso = new Date().toISOString();
  const adessoMs = Date.now();
  const oggi = oggiIso();

  const [{ data: profilo }, { data: faseRitardo }, { data: praticheAperteRaw }, { data: risoltiOggiRaw }, { data: regoleAttive }] = await Promise.all([
    supabase.from("utenti").select("nome, cognome, colore_badge").eq("id", user.id).maybeSingle(),
    supabase
      .from("pratica_fasi")
      .select(`
        id, stato, data_prevista, fase_id,
        fasi_workflow(codice, nome),
        pratiche!inner(id, codice_commissione, stato_generale, operatore_assegnato_id,
          clienti(nome_completo),
          brands(codice, nome, colore)
        )
      `)
      .in("stato", ["da_iniziare", "in_corso"])
      .lt("data_prevista", adesso)
      .eq("pratiche.operatore_assegnato_id", user.id)
      .order("data_prevista", { ascending: true })
      .limit(500),
    // Niente piu' count "head:true": serve il nome cliente per poter escludere
    // le commesse mostra/negozio/expo anche da queste due statistiche (vedi
    // praticaEspositivaDaEscludere in mappature.ts), quindi si conta in JS.
    supabase.from("pratiche").select("codice_commissione, clienti(nome_completo)").eq("operatore_assegnato_id", user.id).not("stato_generale", "in", '("chiusa","annullata")'),
    supabase.from("pratiche").select("codice_commissione, clienti(nome_completo)").eq("operatore_assegnato_id", user.id).eq("stato_generale", "chiusa").gte("data_chiusura_effettiva", `${oggi}T00:00:00Z`),
    supabase.from("regole_alert").select("fase_id, soglia_valore, soglia_unita, livello").eq("attiva", true),
  ]);

  const praticheTotali = (praticheAperteRaw ?? []).filter((p: any) => !praticaEspositivaDaEscludere(p)).length;
  const risoltiOggi = (risoltiOggiRaw ?? []).filter((p: any) => !praticaEspositivaDaEscludere(p)).length;

  const regolePerFase = costruisciMappaRegole(regoleAttive);

  // Esclude anche le commesse di allestimento mostra/negozio/expo: vedi
  // praticaEspositivaDaEscludere in mappature.ts.
  const righeConLivello = (faseRitardo ?? [])
    .filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale) && !praticaEspositivaDaEscludere(r.pratiche))
    .map((r: any) => {
      const oreRitardo = (adessoMs - new Date(r.data_prevista).getTime()) / 3_600_000;
      return { ...r, livello: calcolaLivelloDaRitardo(regolePerFase, r.fase_id, oreRitardo) };
    });

  // Percentuale di merce arrivata in deposito per le pratiche dell'operatore
  // ancora ferme su "arrivo_merce": stessa logica della dashboard direzione.
  const idPraticheArrivoMerce = righeConLivello
    .filter((r: any) => r.fasi_workflow?.codice === "arrivo_merce")
    .map((r: any) => r.pratiche.id);
  const mappaPercentualeMerce = new Map<string, number>();
  if (idPraticheArrivoMerce.length > 0) {
    const { data: percentuali } = await supabase
      .from("v_percentuale_merce_arrivata")
      .select("pratica_id, percentuale_arrivata")
      .in("pratica_id", idPraticheArrivoMerce);
    for (const p of percentuali ?? []) mappaPercentualeMerce.set(p.pratica_id, p.percentuale_arrivata);
  }

  // Avviso "merce parzialmente arrivata" (>=80%, <100%) per le pratiche di
  // CONSEGNA dell'operatore: stessa logica usata nel Monitor Consegne
  // (lib/monitor/caricaDatiConsegne.ts), qui ristretta alle sole pratiche
  // assegnate a questo operatore. Non e' una vera fase in ritardo (la fase
  // "pianificazione_consegna" resta "da_iniziare" finche' non arriva il
  // 100%), quindi va costruita a parte incrociando la stessa vista.
  const { data: praticheConsegnaOperatoreRaw } = await supabase
    .from("pratiche")
    .select("id, codice_commissione, data_consegna_prevista, clienti(nome_completo), brands(codice, nome, colore)")
    .eq("tipo", "consegna")
    .eq("operatore_assegnato_id", user.id)
    .not("stato_generale", "in", '("chiusa","annullata")');

  // Esclude anche le commesse di allestimento mostra/negozio/expo: vedi
  // praticaEspositivaDaEscludere in mappature.ts.
  const praticheConsegnaOperatore = (praticheConsegnaOperatoreRaw ?? []).filter((p: any) => !praticaEspositivaDaEscludere(p));

  const idGiaInCorsoConsegna = new Set(
    righeConLivello.filter((r: any) => r.fasi_workflow?.codice === "pianificazione_consegna").map((r: any) => r.pratiche.id)
  );
  const idDaControllareConsegna = (praticheConsegnaOperatore ?? [])
    .filter((p: any) => !idGiaInCorsoConsegna.has(p.id))
    .map((p: any) => p.id);

  const mappaPercentualeConsegna = new Map<string, number>();
  if (idDaControllareConsegna.length > 0) {
    const { data: percentualiConsegna } = await supabase
      .from("v_percentuale_merce_arrivata")
      .select("pratica_id, percentuale_arrivata")
      .in("pratica_id", idDaControllareConsegna);
    for (const p of percentualiConsegna ?? []) mappaPercentualeConsegna.set(p.pratica_id, p.percentuale_arrivata);
  }

  const opColore = coloreOperatore(user.id, profilo?.colore_badge);
  const opNome = profilo ? `${profilo.nome} ${profilo.cognome}` : "Operatore";

  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;
  const righeOrdinate = [...righeConLivello].sort((a: any, b: any) => {
    const rangoA = RANGO_LIVELLO[a.livello as keyof typeof RANGO_LIVELLO];
    const rangoB = RANGO_LIVELLO[b.livello as keyof typeof RANGO_LIVELLO];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return a.data_prevista.localeCompare(b.data_prevista);
  });

  const alertRowsFasi: AlertRigaMonitor[] = righeOrdinate.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    const { data, ora } = formattaScadenza(r.data_prevista);
    const etichettaParziale = fw?.codice === "arrivo_merce" ? etichettaArrivoMerce(mappaPercentualeMerce.get(p.id)) : null;
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
      descrizione: etichettaParziale ?? `${fw?.nome ?? "Fase"} in ritardo`,
      operatoreNome: opNome,
      operatoreColore: opColore,
      azione: AZIONE_PER_FASE[fw?.codice] ?? "Verificare fase",
      brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
    };
  });

  const alertRowsParzialiConsegna: AlertRigaMonitor[] = (praticheConsegnaOperatore ?? [])
    .filter((p: any) => {
      const perc = mappaPercentualeConsegna.get(p.id);
      return perc != null && perc >= 80 && perc < 100;
    })
    .map((p: any) => {
      const perc = mappaPercentualeConsegna.get(p.id)!;
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

  // Riordina l'unione fasi+avvisi-parziali per priorita' vera (critica in
  // cima, bassa in fondo): alertRowsFasi era gia' ordinato da solo, ma la
  // semplice concatenazione con alertRowsParzialiConsegna (sempre "media")
  // rompeva l'ordine complessivo, es. mostrando "bassa" sopra "media".
  const alertRows: AlertRigaMonitor[] = [...alertRowsFasi, ...alertRowsParzialiConsegna].sort((a, b) => {
    const rangoA = RANGO_LIVELLO[a.livello as keyof typeof RANGO_LIVELLO];
    const rangoB = RANGO_LIVELLO[b.livello as keyof typeof RANGO_LIVELLO];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return `${a.scadenzaData} ${a.scadenzaOra}`.localeCompare(`${b.scadenzaData} ${b.scadenzaOra}`);
  });

  const operatori: OperatoreCardMonitor[] = [{
    id: user.id,
    nome: opNome,
    colore: opColore,
    alertAttivi: alertRows.length,
    urgenti: alertRows.filter((r) => r.livello === "critica").length,
  }];

  const scaduti = righeConLivello.filter((r: any) => r.data_prevista.slice(0, 10) < oggi).length;
  const inScadenzaOggi = righeConLivello.filter((r: any) => r.data_prevista.slice(0, 10) === oggi).length;

  return (
    <div className="h-screen overflow-hidden p-3">
      <MonitorBoard
        titolo={<>LE MIE<br />PRATICHE</>}
        operatori={operatori}
        alertRows={alertRows}
        stats={{
          allertTotali: alertRows.length,
          allertUrgenti: alertRows.filter((r) => r.livello === "critica").length,
          scaduti,
          inScadenzaOggi,
          risoltiOggi: risoltiOggi ?? 0,
          praticheTotali: praticheTotali ?? 0,
        }}
        messaggioVuoto="Nessuna pratica in ritardo al momento: sei in linea con tutte le scadenze."
        mostraSelettoreSchermoIntero={false}
        righeMax={Math.max(alertRows.length, 1)}
      />
    </div>
  );
}
