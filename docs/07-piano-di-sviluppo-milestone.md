# 7. Piano di sviluppo a milestone

Stima indicativa per un piccolo team (1-2 sviluppatori); adattabile in base alle risorse disponibili.

## Milestone 0 — Fondamenta (già consegnata in questo pacchetto)
Schema database, importatore CSV testato sui dati reali, scaffold Next.js/Supabase, motore automazioni di base, template scraper, documentazione.

## Milestone 1 — Setup ambiente e primo import reale (1-2 settimane)
- Creare progetto Supabase, applicare le migrazioni (`supabase/migrations`).
- Creare utenti reali (admin, responsabile, operatori) e configurare le regole di assegnazione vere.
- Eseguire il primo import con `scripts/import-csv` su un export reale e verificare i dati in tabella.
- Deploy iniziale di `apps/web` su Vercel, collegato a Supabase.

## Milestone 2 — Dashboard e schermata pratica operative (2-3 settimane)
- Rifinire dashboard direzione (grafici con recharts, filtri funzionanti).
- Rifinire dashboard operatore e schermata pratica (upload allegati reale su Supabase Storage, modifica note/stati).
- Login e gestione ruoli via Supabase Auth.

## Milestone 3 — Motore automazioni in produzione (1-2 settimane)
- Attivare il cron (Supabase pg_cron o Vercel Cron) per `check-sla`.
- Validare le soglie SLA con la direzione e tararle nella tabella `regole_alert`.
- Notifiche via email (oltre che in-app) per gli alert di livello escalation.

## Milestone 4 — PWA e produttività operatori (2 settimane)
- Manifest + service worker per installabilità mobile.
- Notifiche push.
- Ottimizzazione upload foto da smartphone (compressione lato client).

## Milestone 5 — Automazione import (2-3 settimane, opzionale)
- Se il gestionale non offre export automatico via email: implementare e mettere in produzione lo scraper Playwright (`scraper/`), schedulato (cron esterno o worker sempre attivo).
- Monitoraggio del job di scraping (alert se il download fallisce, es. per cambio password o layout del portale).

## Milestone 6 — Integrazione email per ricezione segnalazioni (2 settimane)
- Collegamento casella email dedicata, parser email → creazione pratica automatica con `canale_origine = 'email'`.

## Milestone 7 — Connettore API del gestionale (quando disponibile)
- Vedi `08-piano-evolutivo-api.md`: sviluppo del nuovo modulo di importazione, esecuzione in parallelo con il CSV per un periodo di validazione, poi switch (`configurazioni.fonte_dati_attiva = 'api'`) e dismissione del CSV.

## Milestone 8 — Rifiniture e hardening
- Test di carico sull'import (dataset con decine di migliaia di righe).
- Audit di sicurezza (RLS, permessi, penetration test leggero).
- Documentazione utente finale e formazione operatori.
