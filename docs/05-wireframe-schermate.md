# 5. Wireframe delle schermate principali

Layout generale: barra laterale fissa (navigazione), contenuto principale a destra. Su mobile la barra laterale collassa in un menu a comparsa (hamburger). Implementazione di riferimento in `apps/web/app/layout.tsx`.

## 5.1 Layout generale

```
┌───────────────┬─────────────────────────────────────────────┐
│  Dasch         │                                              │
│  Assistenze    │   <contenuto pagina>                         │
│                │                                              │
│ Dashboard      │                                              │
│  Direzione     │                                              │
│ Le mie         │                                              │
│  pratiche      │                                              │
│ Admin          │                                              │
│                │                                              │
└───────────────┴─────────────────────────────────────────────┘
```

## 5.2 Dashboard direzione (`/dashboard-direzione`)

```
┌─────────────────────────────────────────────────────────────┐
│ Dashboard Direzione                                          │
├───────────┬───────────┬───────────┬───────────────────────────┤
│ Pratiche  │ Pratiche  │ Tempo     │ Operatori attivi           │
│ aperte    │ in ritardo│ medio     │                            │
│   351     │    47     │  chiusura │        6                  │
│           │  (rosso)  │  4.2 gg   │                            │
├───────────┴───────────┴───────────┴───────────────────────────┤
│ Pratiche per operatore                                         │
│  Operatore | Aperte | In ritardo | Chiuse (30gg)               │
│  Maria     |   82   |     5      |    120                      │
│  Giorgio   |   74   |     9      |    98                       │
│  ...                                                            │
├───────────────────────────────────────────────────────────────┤
│ Ricerca avanzata                                                │
│  [cliente] [operatore] [stato] [categoria] [da–a] [fornitore]  │
└─────────────────────────────────────────────────────────────┘
```

Grafici (da aggiungere con recharts, già incluso nelle dipendenze): andamento pratiche aperte/chiuse nel tempo, distribuzione per categoria, tempo medio per fase.

## 5.3 Dashboard operatore (`/dashboard-operatore`)

```
┌─────────────────────────────────────────────────────────────┐
│ Le mie pratiche                                               │
├─────────────────────────────────────────────────────────────┤
│ Alert e notifiche                                              │
│  ⚠ Pratica 977/26: fase "Ordine ricambi" in ritardo di 30h     │
│  ⚠ Pratica 981/26: presa in carico non avvenuta                │
├─────────────────────────────────────────────────────────────┤
│ Pratiche assegnate (ordinate per priorità e scadenza)          │
│  ┌───────────────────────────────────────────┐  [urgente]      │
│  │ 977/26 — Rullo Bulgarelli                  │                │
│  │ Completamento · scadenza 08/09/2026        │                │
│  └───────────────────────────────────────────┘                │
│  ┌───────────────────────────────────────────┐  [normale]      │
│  │ 974/26 — de luca aldo                      │                │
│  │ Arredo completo · scadenza 07/08/2026      │                │
│  └───────────────────────────────────────────┘                │
└─────────────────────────────────────────────────────────────┘
```

## 5.4 Schermata pratica (`/pratiche/[id]`)

```
┌─────────────────────────────────────┬───────────────────────┐
│ Pratica 977/26                       │ Allegati               │
│ Rullo Bulgarelli · Completamento     │  foto_anta.jpg         │
│ assegnata a Maria Rossi              │  [+ carica file]       │
├───────────────────────────────────────┤                       │
│ Timeline fasi                         │ Storico modifiche      │
│  ● Ricezione — completata             │  06/07 14:02           │
│  ● Presa in carico — completata       │  status: Da ordinare   │
│  ◐ Creazione commissione — in corso   │   → Ordinato           │
│  ○ Ordine ricambi — da iniziare       │  (importazione_csv)    │
│  ○ Arrivo merce                       │                        │
│  ○ Preparazione intervento            │                        │
│  ○ Consegna materiale                 │                        │
│  ○ Chiusura                           │                        │
├───────────────────────────────────────┤                       │
│ Righe / articoli (3)                  │                       │
│  Descrizione | Fornitore | Stato      │                       │
│  anta colonna frigo... | Scavolini |  │                       │
│  Da ordinare                          │                       │
└───────────────────────────────────────┴───────────────────────┘
```

## 5.5 Pannello amministratore (`/admin`)

```
┌─────────────────────────────────────────────────────────────┐
│ Pannello amministratore                                       │
├─────────────────────────────────────────────────────────────┤
│ Regole di assegnazione            [+ nuova regola]            │
│  Cognomi A-C → Maria   | priorità 10 | attiva                 │
│  Cognomi D-M → Giorgio | priorità 20 | attiva                 │
│  Cognomi N-Z → Luca    | priorità 30 | attiva                 │
├─────────────────────────────────────────────────────────────┤
│ Regole SLA / Alert                [+ nuova regola]             │
│  Presa in carico > 24h  → alert responsabile                  │
│  Commissione > 3 giorni → alert responsabile                  │
│  Merce > 30 giorni      → escalation admin+responsabile        │
├─────────────────────────────────────────────────────────────┤
│ Importazioni CSV                                                │
│  piano-di-carico-2026-07-06.csv | completata | 45 nuove | 0 err│
│  [+ importa manualmente]                                        │
├─────────────────────────────────────────────────────────────┤
│ Operatori e utenti                [+ nuovo utente]              │
└─────────────────────────────────────────────────────────────┘
```

## 5.6 Responsive / PWA

Su schermi < 768px: le card KPI si impilano in singola colonna, le tabelle diventano liste di card, la barra laterale si trasforma in menu a scomparsa. L'app operatore è installabile come PWA (manifest + service worker per notifiche push e utilizzo offline-friendly della lista pratiche del giorno).
