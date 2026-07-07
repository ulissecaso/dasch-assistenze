# 8. Piano evolutivo: sostituzione del CSV con un'integrazione API

## 8.1 Principio di progettazione

Fin dall'inizio, il sistema non dipende dal formato CSV: dipende da un **contratto dati interno** (l'elenco di pratiche con le relative righe, così come prodotto da `raggruppaInPratiche()` in `scripts/import-csv/mapToDomain.mjs`). Il modulo che oggi legge un file CSV è solo *uno dei possibili produttori* di quel contratto. Il database, il motore workflow, le dashboard e il frontend non sanno — e non devono sapere — da dove arrivano i dati.

```
oggi:    CSV --> [parser CSV] --> contratto dati interno --> DB
domani:  API gestionale --> [connettore API] --> contratto dati interno --> DB
```

## 8.2 Cosa cambia e cosa non cambia

**Cambia solo:**
- un nuovo modulo `connettori/api-gestionale/` che chiama le API del gestionale invece di leggere un file;
- la modalità di innesco (webhook o polling invece di upload/scraper);
- il campo `pratiche.fonte_dati` passa da `'csv'` a `'api'` per le nuove pratiche.

**Non cambia:**
- lo schema del database;
- la logica di assegnazione automatica e le automazioni SLA;
- le dashboard e l'app operatori;
- la logica di rilevamento "riga nuova / modificata" (adattata da `riga_hash` a un confronto per `updated_at`/versione se l'API la fornisce).

## 8.3 Passi operativi quando l'API sarà disponibile

1. **Analisi della API**: endpoint disponibili, autenticazione, rate limit, formato dati, presenza di webhook per gli aggiornamenti in tempo reale (preferibile al polling).
2. **Mapping**: costruire la stessa funzione `raggruppaInPratiche()`-equivalente a partire dalla risposta API, riusando per quanto possibile `parseNumeroItaliano`/`parseDataItaliana` se i formati sono simili.
3. **Convivenza CSV+API**: durante la fase di transizione, eseguire entrambi i moduli in parallelo su ambiente di test, confrontando i risultati (stesso numero di pratiche, stessi stati) prima di spegnere il CSV.
4. **Switch**: aggiornare `configurazioni.fonte_dati_attiva` a `'api'`, disattivare lo scraper/cron di import CSV (se presente), mantenere il modulo CSV come fallback per qualche settimana.
5. **Webhook in tempo reale (se disponibile)**: sostituire il polling schedulato con un endpoint `/api/webhook/gestionale` che riceve gli eventi e aggiorna le pratiche istantaneamente, eliminando il ritardo di 1-2 aggiornamenti/giorno tipico del CSV.

## 8.4 Rischio e mitigazione

Il rischio principale è che l'API del gestionale, quando disponibile, esponga dati con struttura diversa da quella del CSV attuale (es. nomi campo diversi, codici invece di testo per gli stati). Per questo la funzione di mapping è isolata in un singolo modulo sostituibile, e i test di parsing (`scripts/import-csv/test-parsing.mjs`) fungono da modello per validare rapidamente anche il nuovo connettore contro dati reali prima di collegarlo al database di produzione.
