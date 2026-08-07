// lib/monitor/caricaDettaglioMetrica.ts
// Elenco "pratiche dietro il numero" per le 5 card statistiche mostrate in
// fondo al Monitor (ALLERT TOTALI, SCADUTI, IN SCADENZA OGGI, RISOLTI OGGI,
// PRATICHE TOTALI). A differenza di caricaDatiDirezione.ts e
// caricaDatiConsegne.ts (che filtrano sempre un solo tipo di pratica e,
// spesso, un sottoinsieme di brand), qui l'elenco è SEMPRE su entrambi i
// moduli (assistenza + consegna) e su tutti e tre i brand: le card sono un
// indicatore di salute generale dell'azienda, non della sola board che le
// mostra in questo momento, quindi cliccandoci sopra l'operatore deve poter
// vedere tutto, indipendentemente da quale monitor (Assistenza o Consegne,
// Cinquegrana/Master Mobili/Febal) stava guardando.
//
// Usata da app/api/monitor/dettaglio-metrica/route.ts, chiamata dal modal
// che si apre cliccando una card in MonitorBoard.tsx.
import { praticaEspositivaDaEscludere, costruisciMappaRegole, calcolaLivelloDaRitardo, formattaScadenza } from "@/lib/monitor/mappature";

const FASI_CONSEGNA = ["pianificazione_consegna", "pagamento"];
const SOGLIA_CONSEGNA_PARZIALE = 80;

export type MetricaMonitor = "allertTotali" | "scaduti" | "inScadenzaOggi" | "risoltiOggi" | "praticheTotali";

export type RigaDettaglioMetrica = {
  praticaId: string;
  codice: string;
  cliente: string;
  tipo: "assistenza" | "consegna";
  brand?: { codice: string; nome: string; colore: string };
  operatoreNome: string;
  motivo: string;
  data: string;
};

function oggiIso() {
  return new Date().toISOString().slice(0, 10);
}

export async function caricaDettaglioMetricaMonitor(supabase: any, metrica: MetricaMonitor): Promise<RigaDettaglioMetrica[]> {
  const oggi = oggiIso();

  // RISOLTI OGGI e PRATICHE TOTALI sono conteggi a livello di pratica (non di
  // fase in ritardo): query diretta e più semplice, stessa logica delle due
  // statistiche equivalenti in caricaDatiDirezione.ts/caricaDatiConsegne.ts
  // ma senza filtro tipo/brand.
  if (metrica === "risoltiOggi" || metrica === "praticheTotali") {
    let query = supabase
      .from("pratiche")
      .select(
        "id, codice_commissione, tipo, stato_generale, data_chiusura_effettiva, clienti(nome_completo), utenti:operatore_assegnato_id(nome, cognome), brands(codice, nome, colore)"
      );
    query = metrica === "risoltiOggi"
      ? query.eq("stato_generale", "chiusa").gte("data_chiusura_effettiva", `${oggi}T00:00:00Z`)
      : query.not("stato_generale", "in", '("chiusa","annullata")');

    const { data } = await query;
    return (data ?? [])
      .filter((p: any) => !praticaEspositivaDaEscludere(p))
      .map((p: any) => ({
        praticaId: p.id,
        codice: p.codice_commissione,
        cliente: p.clienti?.nome_completo ?? "—",
        tipo: p.tipo,
        brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
        operatoreNome: p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato",
        motivo: metrica === "risoltiOggi" ? "Chiusa oggi" : "Pratica aperta",
        data: metrica === "risoltiOggi" && p.data_chiusura_effettiva ? formattaScadenza(p.data_chiusura_effettiva).data : "—",
      }))
      .sort((a: RigaDettaglioMetrica, b: RigaDettaglioMetrica) => a.codice.localeCompare(b.codice));
  }

  // ALLERT TOTALI / SCADUTI / IN SCADENZA OGGI: fasi assistenza in ritardo
  // (da_iniziare/in_corso, data_prevista già passata) + fasi consegna
  // "in_corso" (pianificazione_consegna/pagamento), stesse query di
  // caricaDatiDirezione.ts/caricaDatiConsegne.ts ma senza filtro brand e
  // unendo i due tipi in un solo elenco.
  const adesso = new Date().toISOString();
  const adessoMs = Date.now();

  const [{ data: regoleAttive }, { data: faseAssistenza }, { data: faseConsegna }, { data: praticheConsegnaAperte }] = await Promise.all([
    supabase.from("regole_alert").select("fase_id, soglia_valore, soglia_unita, livello").eq("attiva", true),
    supabase
      .from("pratica_fasi")
      .select(
        `id, data_prevista, fase_id, fasi_workflow(codice, nome),
         pratiche!inner(id, codice_commissione, stato_generale, tipo, clienti(nome_completo), utenti:operatore_assegnato_id(nome, cognome), brands(codice, nome, colore))`
      )
      .in("stato", ["da_iniziare", "in_corso"])
      .lt("data_prevista", adesso)
      .eq("pratiche.tipo", "assistenza")
      .not("pratiche.stato_generale", "in", '("chiusa","annullata")')
      .limit(5000),
    supabase
      .from("pratica_fasi")
      .select(
        `id, data_prevista, fase_id, fasi_workflow!inner(codice, nome),
         pratiche!inner(id, codice_commissione, stato_generale, tipo, clienti(nome_completo), utenti:operatore_assegnato_id(nome, cognome), brands(codice, nome, colore))`
      )
      .eq("stato", "in_corso")
      .eq("pratiche.tipo", "consegna")
      .not("pratiche.stato_generale", "in", '("chiusa","annullata")')
      .in("fasi_workflow.codice", FASI_CONSEGNA)
      .limit(5000),
    // Solo per ALLERT TOTALI serve anche l'avviso "merce parzialmente
    // arrivata" delle consegne (stesso criterio di caricaDatiConsegne.ts):
    // per SCADUTI/IN SCADENZA OGGI non si applica, non ha una vera scadenza.
    metrica === "allertTotali"
      ? supabase
          .from("pratiche")
          .select("id, codice_commissione, data_consegna_prevista, clienti(nome_completo), utenti:operatore_assegnato_id(nome, cognome), brands(codice, nome, colore)")
          .eq("tipo", "consegna")
          .not("stato_generale", "in", '("chiusa","annullata")')
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const regolePerFase = costruisciMappaRegole(regoleAttive);
  const conLivello = (righe: any[] | null | undefined, tipo: "assistenza" | "consegna") =>
    (righe ?? [])
      .filter((r: any) => r.pratiche && !["chiusa", "annullata"].includes(r.pratiche.stato_generale) && !praticaEspositivaDaEscludere(r.pratiche))
      .map((r: any) => {
        const oreRitardo = (adessoMs - new Date(r.data_prevista).getTime()) / 3_600_000;
        return { ...r, tipo, livello: calcolaLivelloDaRitardo(regolePerFase, r.fase_id, oreRitardo) };
      });

  let righe = [...conLivello(faseAssistenza, "assistenza"), ...conLivello(faseConsegna, "consegna")];

  if (metrica === "scaduti") righe = righe.filter((r: any) => r.data_prevista.slice(0, 10) < oggi);
  if (metrica === "inScadenzaOggi") righe = righe.filter((r: any) => r.data_prevista.slice(0, 10) === oggi);

  // Una pratica può avere più fasi scadute insieme: teniamo solo la più
  // urgente (stesso principio di dedup di caricaDatiDirezione.ts/
  // caricaDatiConsegne.ts).
  const RANGO_LIVELLO = { critica: 0, alta: 1, media: 2, bassa: 3 } as const;
  righe.sort((a: any, b: any) => {
    const rangoA = RANGO_LIVELLO[a.livello as keyof typeof RANGO_LIVELLO];
    const rangoB = RANGO_LIVELLO[b.livello as keyof typeof RANGO_LIVELLO];
    if (rangoA !== rangoB) return rangoA - rangoB;
    return a.data_prevista.localeCompare(b.data_prevista);
  });
  const viste = new Set<string>();
  const righeUnaPerPratica = righe.filter((r: any) => {
    if (viste.has(r.pratiche.id)) return false;
    viste.add(r.pratiche.id);
    return true;
  });

  const risultato: RigaDettaglioMetrica[] = righeUnaPerPratica.map((r: any) => {
    const p = r.pratiche;
    const fw = r.fasi_workflow;
    return {
      praticaId: p.id,
      codice: p.codice_commissione,
      cliente: p.clienti?.nome_completo ?? "—",
      tipo: r.tipo,
      brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
      operatoreNome: p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato",
      motivo: `${fw?.nome ?? "Fase"} in ritardo`,
      data: formattaScadenza(r.data_prevista).data,
    };
  });

  if (metrica === "allertTotali") {
    const idGiaPresenti = new Set(righeUnaPerPratica.map((r: any) => r.pratiche.id));
    const idDaControllare = (praticheConsegnaAperte ?? []).filter((p: any) => !idGiaPresenti.has(p.id)).map((p: any) => p.id);
    if (idDaControllare.length > 0) {
      const { data: percentuali } = await supabase
        .from("v_percentuale_merce_arrivata")
        .select("pratica_id, percentuale_arrivata")
        .in("pratica_id", idDaControllare);
      const mappaPercentuale = new Map<string, number>();
      for (const perc of percentuali ?? []) mappaPercentuale.set(perc.pratica_id, perc.percentuale_arrivata);
      for (const p of praticheConsegnaAperte ?? []) {
        const perc = mappaPercentuale.get(p.id);
        if (perc != null && perc >= SOGLIA_CONSEGNA_PARZIALE && perc < 100 && !praticaEspositivaDaEscludere(p)) {
          risultato.push({
            praticaId: p.id,
            codice: p.codice_commissione,
            cliente: p.clienti?.nome_completo ?? "—",
            tipo: "consegna",
            brand: p.brands ? { codice: p.brands.codice, nome: p.brands.nome, colore: p.brands.colore } : undefined,
            operatoreNome: p.utenti ? `${p.utenti.nome} ${p.utenti.cognome}` : "Non assegnato",
            motivo: `Merce parzialmente pronta in deposito (${perc}%)`,
            data: p.data_consegna_prevista ? formattaScadenza(p.data_consegna_prevista).data : "—",
          });
        }
      }
    }
  }

  return risultato.sort((a, b) => a.codice.localeCompare(b.codice));
}
