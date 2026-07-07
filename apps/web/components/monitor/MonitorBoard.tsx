// components/monitor/MonitorBoard.tsx
// "Monitor Assistenze": board scura con alert pulsanti, usata sia dalla
// Dashboard Direzione (tutto l'ufficio, pensata per un monitor a parete) sia
// dalla Dashboard Operatore (stessa identica resa grafica, ma con i dati già
// filtrati sulle sole pratiche dell'operatore). La differenza tra le due è
// solo nei dati passati come props dalla pagina server, non nel componente.
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icona } from "./icone";

export type AlertRigaMonitor = {
  id: string;
  livello: "critica" | "alta" | "media" | "bassa";
  scadenzaData: string;
  scadenzaOra: string;
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
  righeMax = 10,
}: {
  titolo: ReactNode;
  operatori: OperatoreCardMonitor[];
  alertRows: AlertRigaMonitor[];
  stats: StatsMonitor;
  messaggioVuoto?: string;
  mostraSelettoreSchermoIntero?: boolean;
  righeMax?: number;
}) {
  const [ora, setOra] = useState<{ data: string; clock: string }>({ data: "", clock: "" });
  const [kiosk, setKiosk] = useState(false);
  const [soloUrgenti, setSoloUrgenti] = useState(false);
  const boardRef = useRef<HTMLDivElement>(null);

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
          <div className="mon-time">
            <div>{ora.data}</div>
            <div className="clock">{ora.clock}</div>
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

        <div className="mon-section-title">
          <div className="left"><Icona nome="warning" className="ic" /> ALERT CON SCADENZA PIÙ IMMINENTE</div>
          <div className="mon-filter" onClick={() => setSoloUrgenti((v) => !v)}>
            <Icona nome="filter" className="ic" /> {soloUrgenti ? "Mostra tutti" : "Mostra solo urgenti"}
          </div>
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
                  <tr key={r.id} className={`pulse-${r.livello}`} style={{ "--v": VELOCITA_PULSE[r.livello] } as any}>
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
.monitor-board{background:#0a0e16;color:#e5e7eb;padding:20px 26px;border-radius:16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;
  display:flex;flex-direction:column;height:100%;box-sizing:border-box;overflow:hidden;}
.mon-topbar{flex:0 0 auto;display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;}
.mon-exit{background:#1a2130;color:#9ca3af;border:1px solid #2a3242;border-radius:8px;padding:6px 12px;font-size:12.5px;cursor:pointer;}
.mon-time{text-align:right;font-size:13px;color:#9ca3af;}
.mon-time .clock{font-size:20px;font-weight:700;color:#fff;}
.mon-header{flex:0 0 auto;display:flex;justify-content:space-between;align-items:center;gap:20px;margin-bottom:14px;flex-wrap:wrap;}
.mon-header h1{color:#fff;font-size:30px;line-height:1.15;letter-spacing:.3px;margin:0;text-align:right;}
.op-row{display:flex;flex-wrap:wrap;gap:10px;}
.op-card{width:200px;border-radius:12px;padding:8px 12px;background:#0f1420;border:1.5px solid;}
.op-card-top{display:flex;align-items:center;gap:10px;margin-bottom:6px;}
.op-card .op-name{font-weight:700;font-size:14px;color:#fff;line-height:1.15;}
.op-card .op-role{font-size:11px;color:#9ca3af;}
.op-avatar{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.op-avatar .ic{width:22px;height:22px;color:#fff;}
.op-card-bottom{display:flex;align-items:center;justify-content:space-between;}
.op-count-block{display:flex;flex-direction:column;align-items:flex-start;line-height:1;}
.op-count{font-size:30px;font-weight:800;color:#fff;line-height:1;}
.op-count-label{font-size:10.5px;color:#9ca3af;letter-spacing:.5px;margin-top:3px;}
.op-urgent{font-size:13px;font-weight:800;white-space:nowrap;}
.mon-section-title{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;flex-wrap:wrap;gap:8px;}
.mon-section-title .left{display:flex;align-items:center;gap:8px;color:#f87171;font-weight:700;font-size:15px;letter-spacing:.3px;}
.mon-section-title .left .ic{width:20px;height:20px;color:#f87171;}
.mon-filter{background:#131a26;border:1px solid #2a3242;color:#cbd5e1;border-radius:8px;padding:6px 10px;font-size:12.5px;display:flex;align-items:center;gap:6px;cursor:pointer;}
.mon-filter .ic{width:14px;height:14px;color:#cbd5e1;}
.mon-table-wrap{flex:1 1 auto;min-height:0;background:#0f1420;border:1px solid #1e2634;border-radius:14px;overflow:auto;margin-bottom:12px;}
.mon-empty{padding:26px;color:#8b96a8;font-size:13.5px;}
.mon-table{width:100%;border-collapse:collapse;font-size:12.5px;}
.mon-table th{text-align:left;color:#8b96a8;font-weight:600;font-size:10.5px;letter-spacing:.4px;text-transform:uppercase;padding:9px 12px;border-bottom:1px solid #1e2634;background:#0c111c;position:sticky;top:0;}
.mon-table td{padding:8px 12px;border-bottom:1px solid #171e2b;color:#e5e7eb;vertical-align:middle;}
.mon-table tr:last-child td{border-bottom:none;}
.mon-badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:6px;font-size:11px;font-weight:700;letter-spacing:.3px;}
.mon-badge.critica{background:#3a1418;color:#f87171;}
.mon-badge.alta{background:#3a2410;color:#fb923c;}
.mon-badge.media{background:#3a3010;color:#facc15;}
.mon-badge.bassa{background:#123420;color:#4ade80;}
.fase-cell{display:flex;align-items:center;gap:8px;color:#cbd5e1;}
.fase-cell .ic{width:16px;height:16px;flex-shrink:0;color:#8b96a8;}
.op-cell{display:flex;align-items:center;gap:8px;}
.op-dot{width:9px;height:9px;border-radius:50%;flex-shrink:0;}
.mon-stats{flex:0 0 auto;display:grid;grid-template-columns:repeat(5,1fr);gap:12px;}
.mon-stat{background:#0f1420;border:1px solid #1e2634;border-radius:12px;padding:12px 16px;}
.mon-stat .lbl{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.4px;margin-bottom:6px;}
.mon-stat .val{color:#fff;font-size:20px;font-weight:700;}
.mon-stat .val small{font-size:11.5px;font-weight:500;color:#8b96a8;margin-left:4px;}
.ic{display:inline-flex;width:16px;height:16px;vertical-align:middle;flex-shrink:0;}
.mon-stat .lbl .ic{width:24px;height:24px;}
.mon-stat .lbl .ic-bell{width:27px;height:27px;}
.ic-red{color:#f87171;}
.ic-orange{color:#fb923c;}
.ic-yellow{color:#facc15;}
.ic-green{color:#4ade80;}

@keyframes rowPulseRed{0%,100%{background-color:rgba(239,68,68,.05);}50%{background-color:rgba(239,68,68,.16);}}
@keyframes rowPulseOrange{0%,100%{background-color:rgba(249,115,22,.04);}50%{background-color:rgba(249,115,22,.13);}}
@keyframes rowPulseYellow{0%,100%{background-color:rgba(234,179,8,.03);}50%{background-color:rgba(234,179,8,.10);}}
@keyframes rowPulseGreen{0%,100%{background-color:rgba(34,197,94,.02);}50%{background-color:rgba(34,197,94,.07);}}
.mon-table tr.pulse-critica{animation:rowPulseRed var(--v,.9s) ease-in-out infinite;}
.mon-table tr.pulse-alta{animation:rowPulseOrange var(--v,1.5s) ease-in-out infinite;}
.mon-table tr.pulse-media{animation:rowPulseYellow var(--v,2.2s) ease-in-out infinite;}
.mon-table tr.pulse-bassa{animation:rowPulseGreen var(--v,3s) ease-in-out infinite;}

@keyframes badgeGlowRed{0%,100%{box-shadow:0 0 0 rgba(248,113,113,0);}50%{box-shadow:0 0 9px 1px rgba(248,113,113,.75);}}
@keyframes badgeGlowOrange{0%,100%{box-shadow:0 0 0 rgba(251,146,60,0);}50%{box-shadow:0 0 9px 1px rgba(251,146,60,.7);}}
@keyframes badgeGlowYellow{0%,100%{box-shadow:0 0 0 rgba(250,204,21,0);}50%{box-shadow:0 0 8px 1px rgba(250,204,21,.6);}}
@keyframes badgeGlowGreen{0%,100%{box-shadow:0 0 0 rgba(74,222,128,0);}50%{box-shadow:0 0 7px 1px rgba(74,222,128,.5);}}
.mon-badge.critica{animation:badgeGlowRed .9s ease-in-out infinite;}
.mon-badge.alta{animation:badgeGlowOrange 1.5s ease-in-out infinite;}
.mon-badge.media{animation:badgeGlowYellow 2.2s ease-in-out infinite;}
.mon-badge.bassa{animation:badgeGlowGreen 3s ease-in-out infinite;}

@keyframes iconGlowRed{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(248,113,113,0));}50%{transform:scale(1.22);filter:drop-shadow(0 0 5px rgba(248,113,113,.95));}}
@keyframes iconGlowOrange{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(251,146,60,0));}50%{transform:scale(1.18);filter:drop-shadow(0 0 5px rgba(251,146,60,.9));}}
@keyframes iconGlowYellow{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(250,204,21,0));}50%{transform:scale(1.15);filter:drop-shadow(0 0 4px rgba(250,204,21,.8));}}
@keyframes iconGlowGreen{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgba(74,222,128,0));}50%{transform:scale(1.12);filter:drop-shadow(0 0 4px rgba(74,222,128,.7));}}
.ic-red{animation:iconGlowRed .9s ease-in-out infinite;}
.ic-orange{animation:iconGlowOrange 1.5s ease-in-out infinite;}
.ic-yellow{animation:iconGlowYellow 2.2s ease-in-out infinite;}
.ic-green{animation:iconGlowGreen 3s ease-in-out infinite;}
.mon-section-title .left .ic{animation:iconGlowRed .9s ease-in-out infinite;}

@keyframes ringBell{0%,60%,100%{transform:rotate(0deg);}62%{transform:rotate(15deg);}64%{transform:rotate(-13deg);}66%{transform:rotate(10deg);}68%{transform:rotate(-8deg);}70%{transform:rotate(6deg);}72%{transform:rotate(-4deg);}74%{transform:rotate(2deg);}76%{transform:rotate(0deg);}}
.ic-bell{transform-origin:50% 8%;animation:ringBell 2.2s ease-in-out infinite;}

@media (prefers-reduced-motion: reduce){
  .mon-table tr, .mon-badge, .ic{animation:none !important;}
}
`;
