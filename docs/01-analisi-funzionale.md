# 1. Analisi funzionale — Dasch Gestione Assistenze

## 1.1 Obiettivo

Sostituire il monitoraggio manuale delle pratiche di assistenza post-vendita con una piattaforma che:

- riceve e registra automaticamente le segnalazioni dei clienti;
- assegna le pratiche agli operatori secondo regole configurabili;
- tiene traccia di ogni fase operativa (stato, date, responsabile, note, allegati, storico);
- si aggiorna importando i CSV esportati dal gestionale esistente, senza richiedere modifiche al gestionale stesso;
- genera alert ed escalation automatiche in base a soglie (SLA) configurabili;
- espone dashboard per la direzione e per ogni operatore.

L'architettura è pensata perché il modulo di importazione CSV possa essere sostituito da un connettore API in futuro, senza toccare il resto del sistema (vedi `08-piano-evolutivo-api.md`).

## 1.2 Dati reali disponibili oggi

Il file di esempio fornito (`Piano di carico - Vamart.csv`, esportato dal gestionale) contiene 6.016 righe che si raggruppano in 2.281 pratiche distinte (identificate dal "Codice commissione", es. `977/26`), relative a 1.367 clienti e 73 fornitori. Ogni riga rappresenta un articolo/attività della pratica con il proprio stato di avanzamento (`Da ordinare`, `Ordinato`, `In giacenza`, `Parzialmente consegnato`, `Consegnato`). Questa struttura è già l'equivalente della "commissione di assistenza" descritta nel flusso operativo, e ha guidato direttamente lo schema del database e la logica di importazione (vedi `03-schema-database.md` e `scripts/import-csv`).

## 1.3 Flusso operativo end-to-end

1. **Ricezione segnalazione** — il cliente apre una richiesta tramite App, oppure la segnalazione arriva via email; in entrambi i casi la pratica viene registrata a sistema (in una fase successiva, quando sarà collegata la casella email, tramite un parser dedicato; oggi tramite import CSV/manuale).
2. **Presa in carico** — un operatore (assegnato automaticamente) apre la pratica.
3. **Apertura pratica / creazione commissione** — corrisponde alla creazione del "Codice commissione" nel gestionale.
4. **Invio ordine ricambi** — corrisponde allo stato `Ordinato` sulle righe della pratica.
5. **Arrivo merce in deposito** — corrisponde allo stato `In giacenza`.
6. **Preparazione intervento** — fase organizzativa lato operatore (non presente nel CSV, gestita internamente dall'app).
7. **Consegna materiale** — corrisponde allo stato `Consegnato` / `Parzialmente consegnato`.
8. **Chiusura assistenza** — quando tutte le righe della pratica risultano consegnate.

Ogni fase ha: stato, data prevista, data effettiva, responsabile, note, allegati e storico modifiche (tabelle `pratica_fasi` e `storico_modifiche`, vedi schema DB).

## 1.4 Assegnazione automatica

Le pratiche vengono assegnate automaticamente a un operatore in base a regole configurabili dall'admin (tabella `regole_assegnazione`). L'esempio di specifica (A-C → Maria, D-M → Giorgio, N-Z → Luca) è implementato come criterio "iniziale cognome" ma il motore supporta anche criteri per categoria, fornitore o zona, ed è completamente gestibile da pannello amministratore senza intervento tecnico.

## 1.5 Automazioni e SLA

Il motore di alert (tabella `regole_alert` + funzione schedulata `check-sla`) supporta condizioni come:

- fase non iniziata entro X ore (es. presa in carico entro 24h);
- fase non completata entro Y giorni (es. creazione commissione entro 3 giorni);
- materiale non arrivato entro Z giorni;
- pratica ferma da troppo tempo → escalation ai responsabili.

Tutte le soglie, i destinatari e i livelli (info/alert/escalation) sono configurabili da admin, senza modifiche al codice.

## 1.6 Dashboard

**Dashboard direzione**: pratiche aperte, pratiche in ritardo, pratiche per operatore, tempi medi di chiusura, KPI, grafici, filtri e ricerca avanzata.

**Dashboard operatore**: pratiche assegnate, priorità, scadenze, alert, attività giornaliere.

## 1.7 Applicazione dipendenti (web/PWA)

Ogni operatore, da qualsiasi dispositivo (anche mobile, grazie alla PWA), può: vedere le proprie pratiche, aggiornare stati e fasi, inserire note, caricare foto/documenti, ricevere notifiche push, consultare lo storico.

## 1.8 Pannello amministratore

Configurazione di: operatori e permessi, regole di assegnazione, tempi/SLA di ogni fase, priorità, notifiche, importazioni CSV (upload manuale + log), log di sistema.

## 1.9 Alimentazione dati e futura integrazione API

Oggi il sistema si aggiorna tramite import dei CSV esportati dal gestionale (1-2 volte al giorno, anche automatizzabile con lo scraper descritto in `09-scraper-automatico.md`). L'architettura isola questa logica in un modulo di importazione sostituibile: quando il gestionale offrirà un'API, basterà implementare un nuovo "connettore" con la stessa interfaccia (stessa struttura di pratiche/righe in output) senza toccare database, dashboard, automazioni o frontend (vedi `08-piano-evolutivo-api.md`).
