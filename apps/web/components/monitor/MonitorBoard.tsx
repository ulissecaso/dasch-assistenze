// components/monitor/MonitorBoard.tsx
// "Monitor Assistenze": board scura con alert pulsanti, usata sia dalla
// Dashboard Direzione (tutto l'ufficio, pensata per un monitor a parete) sia
// dalla Dashboard Operatore (stessa identica resa grafica, ma con i dati già
// filtrati sulle sole pratiche dell'operatore). La differenza tra le due è
// solo nei dati passati come props dalla pagina server, non nel componente.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Icona } from "./icone";

export type AlertRigaMonitor = {
  id: string;
  livello: "critica" | "alta" | "media" | "bassa";
  scadenzaData: string;
  scadenzaOra: string;
  /** id della pratica (non il codice commissione): serve per il link verso
   *  /pratiche/[id] quando la riga è cliccabile (vedi righeCliccabili). */
  praticaId: string;
  praticaCodice: string;
  cliente: string;
  faseNome: string;
  faseIcona: string;
  descrizione: string;
  operatoreNome: string;
  operatoreColore: string;
  azione: string;
};

export type OperatoreCardMonitor = {
  id: string;
  nome: string;
  colore: string;
  alertAttivi: number;
  urgenti: number;
};

export type StatsMonitor = {
  allertTotali: number;
  allertUrgenti: number;
  scaduti: number;
  inScadenzaOggi: number;
  risoltiOggi: number;
  praticheTotali: number;
};

const VELOCITA_PULSE: Record<string, string> = {
  critica: "0.9s", alta: "1.5s", media: "2.2s", bassa: "3s",
};

export default function MonitorBoard({
  titolo,
  operatori,
  alertRows,
  stats,
  messaggioVuoto = "Nessun alert al momento: tutte le pratiche sono in linea con le scadenze.",
  mostraSelettoreSchermoIntero = true,
  righeMax = 11,
  // Il monitor pubblico a parete (/monitor/direzione) non deve avere NESSUN
  // link verso il resto del portale (vedi commento in quel file: nessuna
  // sessione admin deve essere raggiungibile da quello schermo). Le due
  // dashboard autenticate (direzione e operatore) invece vogliono poter
  // aprire la pratica cliccando sulla riga, quindi di default è true.
  righeCliccabili = true,
}: {
  titolo: ReactNode;
  operatori: OperatoreCardMonitor[];
  alertRows: AlertRigaMonitor[];
  stats: StatsMonitor;
  messaggioVuoto?: string;
  mostraSelettoreSchermoIntero?: boolean;
  righeMax?: number;
  righeCliccabili?: boolean;
}) {
  const [ora, setOra] = useState<{ data: string; clock: string }>({ data: "", clock: "" });
  const [kiosk, setKiosk] = useState(false);
  const [soloUrgenti, setSoloUrgenti] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  useEffect(() => {
    const mesi = ["GENNAIO", "FEBBRAIO", "MARZO", "APRILE", "MAGGIO", "GIUGNO", "LUGLIO", "AGOSTO", "SETTEMBRE", "OTTOBRE", "NOVEMBRE", "DICEMBRE"];
    const tick = () => {
      const now = new Date();
      setOra({
        data: `${now.getDate()} ${mesi[now.getMonth()]} ${now.getFullYear()}`,
        clock: now.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" }),
      });
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  async function toggleKiosk() {
    try {
      if (!kiosk && boardRef.current) {
        await boardRef.current.requestFullscreen?.();
      } else if (document.fullscreenElement) {
        await document.exitFullscreen?.();
      }
    } catch {
      // Fullscreen API può fallire se non attivata da un gesto utente diretto
      // o non supportata dal browser: la board resta comunque usabile.
    }
    setKiosk((k) => !k);
  }

  const righeVisibili = (soloUrgenti ? alertRows.filter((r) => r.livello === "critica") : alertRows).slice(0, righeMax);

  return (
    <div ref={boardRef} className="mon-wrap">
      <style>{CSS}</style>
      <div className="monitor-board">
        <div className="mon-topbar">
          {mostraSelettoreSchermoIntero ? (
            <button className="mon-exit" onClick={toggleKiosk}>
              {kiosk ? "✕ Esci da schermo intero" : "🖥 Schermo intero"}
            </button>
          ) : <span />}
          <div className="mon-title-center">
            <span className="left"><Icona nome="warning" className="ic" /> ALERT CON SCADENZA PIÙ IMMINENTE</span>
            <span className="mon-time-inline">{ora.data} · {ora.clock}</span>
          </div>
          <div className="mon-filter" onClick={() => setSoloUrgenti((v) => !v)}>
            <Icona nome="filter" className="ic" /> {soloUrgenti ? "Mostra tutti" : "Mostra solo urgenti"}
          </div>
        </div>

        <div className="mon-header">
          <div className="op-row">
            {operatori.map((op) => (
              <div key={op.id} className="op-card" style={{ borderColor: op.colore }}>
                <div className="op-card-top">
                  <div className="op-avatar" style={{ background: op.colore }}>
                    <Icona nome="person" className="ic" />
                  </div>
                  <div>
                    <div className="op-name">{op.nome.toUpperCase()}</div>
                    <div className="op-role">Operatore</div>
                  </div>
                </div>
                <div className="op-card-bottom">
                  <div className="op-count-block">
                    <div className="op-count">{op.alertAttivi}</div>
                    <div className="op-count-label">ALERT ATTIVI</div>
                  </div>
                  {op.urgenti > 0 && (
                    <div className="op-urgent" style={{ color: op.colore }}>{op.urgenti} URGENTI</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <h1>{titolo}</h1>
        </div>

        <div className="mon-table-wrap">
          {righeVisibili.length === 0 ? (
            <p className="mon-empty">{messaggioVuoto}</p>
          ) : (
            <table className="mon-table">
              <thead>
                <tr>
                  <th></th><th>Priorità</th><th>Scadenza</th><th>Pratica</th><th>Cliente</th>
                  <th>Fase in ritardo</th><th>Descrizione</th><th>Operatore</th><th>Azione richiesta</th>
                </tr>
              </thead>
              <tbody>
                {righeVisibili.map((r) => (
                  <tr
                    key={r.id}
                    className={`pulse-${r.livello}${righeCliccabili ? " riga-cliccabile" : ""}`}
                    style={{ "--v": VELOCITA_PULSE[r.livello] } as any}
                    onClick={righeCliccabili ? () => router.push(`/pratiche/${r.praticaId}`) : undefined}
                    title={righeCliccabili ? "Apri pratica" : undefined}
                  >
                    <td><Icona nome="warn-sm" className={`ic ic-${r.livello === "critica" ? "red" : r.livello === "alta" ? "orange" : r.livello === "media" ? "yellow" : "green"}`} /></td>
                    <td><span className={`mon-badge ${r.livello}`}>{r.livello.toUpperCase()}</span></td>
                    <td>{r.scadenzaData}<br />{r.scadenzaOra}</td>
                    <td>{r.praticaCodice}</td>
                    <td>{r.cliente}</td>
                    <td><div className="fase-cell"><Icona nome={r.faseIcona as any} className="ic" /> {r.faseNome}</div></td>
                    <td>{r.descrizione}</td>
                    <td><div className="op-cell"><span className="op-dot" style={{ background: r.operatoreColore }} />{r.operatoreNome}</div></td>
                    <td>{r.azione}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="mon-stats">
          <div className="mon-stat"><div className="lbl" style={{ color: "#f87171" }}><Icona nome="bell" className="ic ic-bell" /> ALLERT TOTALI</div><div className="val">{stats.allertTotali} <small>di cui {stats.allertUrgenti} urgenti</small></div></div>
          <div className="mon-stat"><div className="lbl" style={{ color: "#fb923c" }}><Icona nome="clock" className="ic" /> SCADUTI</div><div className="val">{stats.scaduti} <small>da gestire</small></div></div>
          <div className="mon-stat"><div className="lbl" style={{ color: "#facc15" }}><Icona nome="alert-circle" className="ic" /> IN SCADENZA OGGI</div><div className="val">{stats.inScadenzaOggi}</div></div>
          <div className="mon-stat"><div className="lbl" style={{ color: "#60a5fa" }}><Icona nome="check-circle" className="ic" /> RISOLTI OGGI</div><div className="val">{stats.risoltiOggi}</div></div>
          <div className="mon-stat"><div className="lbl" style={{ color: "#4ade80" }}><Icona nome="calendar" className="ic" /> PRATICHE TOTALI</div><div className="val">{stats.praticheTotali} <small>aperte</small></div></div>
        </div>
      </div>
    </div>
  );
}

const CSS = `
.mon-wrap{background:#0a0e16;height:100%;display:flex;flex-direction:column;}
.mon-wrap:fullscreen{overflow:auto;padding:22px 28px;}
.monitor-board{background:#0a0e16;color:#e5e7eb;padding:14px 22px;border-radius:16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden;}
.mon-topbar{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:10px;}
.mon-exit{background:#1a2130;color:#9ca3af;border:1px solid #2a3242;border-radius:8px;padding:5px 10px;font-size:12px;cursor:pointer;flex-shrink:0;}
.mon-title-center{flex:1 1 auto;display:flex;align-items:baseline;justify-content:center;gap:14px;flex-wrap:wrap;}
.mon-title-center .left{display:flex;align-items:center;gap:7px;color:#f87171;font-weight:700;font-size:14.5px;letter-spacing:.3px;white-space:nowrap;}
.mon-title-center .left .ic{width:18px;height:18px;color:#f87171;}
.mon-time-inline{font-size:13px;color:#9ca3af;white-space:nowrap;}
.mon-header{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:16px;margin-bottom:8px;flex-wrap:wrap;}
.mon-header h1{color:#fff;font-size:22px;line-height:1.1;letter-spacing:.3px;margin:0;text-align:right;}
.op-row{display:flex;flex-wrap:wrap;gap:8px;}
.op-card{width:180px;border-radius:10px;padding:6px 10px;background:#0f1420;border:1.5px solid;}
.op-card-top{display:flex;align-items:center;gap:8px;margin-bottom:3px;}
.op-card .op-name{font-weight:700;font-size:12.5px;color:#fff;line-height:1.15;}
.op-card .op-role{font-size:10px;color:#9ca3af;}
.op-avatar{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.op-avatar .ic{width:17px;height:17px;color:#fff;}
.op-card-bottom{display:flex;align-items:center;justify-content:space-between;}
.op-count-block{display:flex;flex-direction:column;align-items:flex-start;line-height:1;}
.op-count{font-size:22px;font-weight:800;color:#fff;line-height:1;}
.op-count-label{font-size:9.5px;color:#9ca3af;letter-spacing:.5px;margin-top:2px;}
.op-urgent{font-size:12px;font-weight:800;white-space:nowrap;}
.mon-filter{background:#131a26;border:1px solid #2a3242;color:#cbd5e1;border-radius:8px;padding:5px 9px;font-size:12px;display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;}
.mon-filter .ic{width:13px;height:13px;color:#cbd5e1;}
.mon-table-wrap{flex:1 1 auto;min-height:0;background:#0f1420;border:1px solid #1e2634;border-radius:12px;overflow:auto;margin-bottom:10px;}
.mon-empty{padding:22px;color:#8b96a8;font-size:13px;}
.mon-table{width:100%;border-collapse:collapse;font-size:13.5px;}
.mon-table th{text-align:left;color:#8b96a8;font-weight:600;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;padding:8px 14px;border-bottom:1px solid #1e2634;background:#0c111c;position:sticky;top:0;}
.mon-table td{padding:9px 14px;border-bottom:1px solid #171e2b;color:#e5e7eb;vertical-align:middle;line-height:1.3;}
.mon-table tr:last-child td{border-bottom:none;}
.mon-table tr.riga-cliccabile{cursor:pointer;}
.mon-table tr.riga-cliccabile:hover{background-color:rgba(255,255,255,.06) !important;}
.mon-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:6px;font-size:10.5px;font-weight:700;letter-spacing:.3px;}
.mon-badge.critica{background:#3a1418;color:#f87171;}
.mon-badge.alta{background:#3a2410;color:#fb923c;}
.mon-badge.media{background:#3a3010;color:#facc15;}
.mon-badge.bassa{background:#123420;color:#4ade80;}
.fase-cell{display:flex;align-item
