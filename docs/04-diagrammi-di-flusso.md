# 4. Diagrammi di flusso

## 4.1 Ciclo di vita di una pratica

```mermaid
flowchart TD
    A[Cliente apre segnalazione: App / Email / CSV] --> B[Registrazione pratica nel DB]
    B --> C{Assegnazione automatica<br/>regole_assegnazione}
    C --> D[Operatore assegnato notificato]
    D --> E[Presa in carico]
    E --> F[Apertura pratica / Creazione commissione]
    F --> G[Invio ordine ricambi]
    G --> H[Arrivo merce in deposito]
    H --> I[Preparazione intervento]
    I --> J[Consegna materiale]
    J --> K[Chiusura assistenza]
    K --> L[Pratica chiusa - KPI aggiornati]

    E -.SLA scaduto.-> M[Alert responsabile]
    G -.SLA scaduto.-> M
    H -.SLA scaduto.-> M
    M -.persiste.-> N[Escalation]
```

## 4.2 Flusso di importazione CSV

```mermaid
flowchart LR
    A[Export CSV dal gestionale<br/>manuale o scraper] --> B[Upload / pickup file]
    B --> C[Parsing e normalizzazione<br/>date, numeri, encoding]
    C --> D{Riga valida?}
    D -- no --> E[Log errore riga<br/>importazioni_csv_errori]
    D -- si --> F{Pratica esistente?<br/>match su codice_commissione}
    F -- no --> G[Crea nuova pratica + righe]
    F -- si --> H{Riga cambiata?<br/>confronto riga_hash}
    H -- no --> I[Nessuna azione]
    H -- si --> J[Aggiorna riga + storico_modifiche]
    G --> K[Aggiorna contatori importazioni_csv]
    J --> K
    I --> K
    E --> K
    K --> L[Importazione completata / con errori]
```

## 4.3 Motore automazioni SLA (eseguito periodicamente)

```mermaid
flowchart TD
    A[Trigger schedulato ogni 15 min<br/>pg_cron / Vercel Cron] --> B[Legge regole_alert attive]
    B --> C{Tipo condizione}
    C -- fase_non_iniziata_entro / fase_non_completata_entro --> D[Query v_pratiche_in_ritardo]
    C -- pratica_ferma_da --> E[Query pratiche non aggiornate da N giorni]
    D --> F{Soglia superata?}
    E --> F
    F -- si --> G{Notifica gia' inviata<br/>nelle ultime 24h?}
    G -- no --> H[Crea notifica per operatore + responsabile]
    G -- si --> I[Nessuna azione - evita spam]
    F -- no --> I
```

## 4.4 Assegnazione automatica operatore

```mermaid
flowchart LR
    A[Nuova pratica creata] --> B{operatore_assegnato_id<br/>gia' impostato?}
    B -- si --> Z[Nessuna azione]
    B -- no --> C[Estrae iniziale cognome cliente]
    C --> D[Cerca in regole_assegnazione<br/>attive, ordinate per priorita]
    D --> E{Match trovato?}
    E -- si --> F[Assegna operatore]
    E -- no --> G[Pratica non assegnata<br/>visibile solo ad admin/responsabile]
```
