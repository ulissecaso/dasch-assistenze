# 2. Analisi tecnica e architettura software

## 2.1 Stack tecnologico scelto (e perché)

| Livello | Scelta | Motivazione |
|---|---|---|
| Frontend + API | **Next.js 14 (React, App Router)** | Un unico progetto serve sia le pagine (dashboard, admin, app operatori) sia le API route (import CSV, cron). Deploy diretto su **Vercel**, che l'utente già conosce. Supporta PWA per l'app operatori. |
| Database + Auth + Storage | **Supabase (PostgreSQL)** | Database relazionale robusto per uno schema con molte relazioni (pratiche, fasi, storico...). Auth pronta all'uso con ruoli, Storage per gli allegati, Row Level Security nativa, Edge Functions per le automazioni. L'utente lo conosce già. |
| Automazioni schedulate | **Supabase Edge Functions + pg_cron** (alternativa: Vercel Cron) | Esecuzione periodica del motore SLA senza infrastruttura aggiuntiva da gestire. |
| Repository / CI | **GitHub** | Storico versioni, collaborazione, integrazione diretta con Vercel per deploy automatico ad ogni push. |
| Import CSV | **Node.js (script CLI + libreria condivisa)** | Stesso linguaggio del resto dello stack; facilmente eseguibile da cron, da Edge Function o localmente. |
| Scraper opzionale | **Playwright (Node.js)** | Automatizza login e download dal portale del gestionale se non sarà mai disponibile un export via email/API. |

Questo stack è stato scelto in base a cosa l'utente già sa usare (GitHub, Supabase, Vercel, Netlify), per minimizzare la curva di apprendimento operativa e concentrare lo sforzo sul dominio applicativo.

## 2.2 Architettura a moduli

```
┌─────────────────────────────────────────────────────────────────┐
│                        FRONTEND (Next.js)                        │
│  Dashboard direzione · Dashboard operatore · App/PWA · Admin      │
└───────────────┬───────────────────────────────────┬─────────────┘
                │ (API routes / server components)   │
┌───────────────▼───────────────┐   ┌────────────────▼────────────┐
│      BACKEND API (Next.js)     │   │   SUPABASE (Postgres+Auth)  │
│  /api/import-csv               │──▶│  Tabelle, RLS, Storage,      │
│  /api/cron/check-sla           │   │  Edge Functions, pg_cron     │
└───────────────┬────────────────┘   └───────────────┬──────────────┘
                │                                     │
┌───────────────▼───────────────┐   ┌────────────────▼──────────────┐
│  MODULO IMPORTAZIONE DATI      │   │   MOTORE WORKFLOW/AUTOMAZIONI  │
│  (sostituibile)                │   │  Assegnazione automatica       │
│  - oggi: importatore CSV       │   │  Motore SLA/alert (check-sla)   │
│  - domani: connettore API       │   │  Notifiche                     │
│  - opzionale: scraper Playwright│   └─────────────────────────────────┘
└─────────────────────────────────┘
```

Il **modulo di importazione dati** espone sempre lo stesso "contratto" in output (un insieme di pratiche con le relative righe, in un formato interno comune — vedi `scripts/import-csv/mapToDomain.mjs`). Che il dato arrivi da un CSV o da una futura API, il resto del sistema (database, motore workflow, dashboard) non cambia. Questo è il punto cardine per l'evoluzione futura (`08-piano-evolutivo-api.md`).

## 2.3 Gestione email (fase 2)

Per ricevere automaticamente le segnalazioni via email è prevista una casella dedicata (es. `assistenza@dominio.it`) collegata tramite un provider con webhook (es. Postmark, SendGrid Inbound Parse, o Gmail API con push notification). Un parser email estrae cliente, descrizione e allegati e crea la pratica con `canale_origine = 'email'`. Questo modulo è disaccoppiato dal resto (stesso principio del modulo CSV) e può essere aggiunto senza modifiche strutturali.

## 2.4 Sicurezza e GDPR

- **Autenticazione**: Supabase Auth (email/password o SSO), sessioni via cookie httpOnly.
- **Ruoli e permessi**: `admin`, `responsabile`, `operatore` — applicati sia in Row Level Security (Postgres) sia lato UI.
- **Audit log**: tabella `log_attivita` registra login, modifiche, importazioni, export.
- **Cronologia modifiche**: tabella `storico_modifiche`, immutabile (solo insert), per tracciare ogni cambio di stato/campo.
- **Cifratura dati sensibili**: dati a riposo cifrati nativamente da Supabase (Postgres su disco cifrato); connessioni sempre TLS.
- **Backup**: backup automatici giornalieri di Supabase (point-in-time recovery nei piani a pagamento); esportazione periodica su storage esterno consigliata per dati critici.
- **GDPR**: minimizzazione dei dati cliente (solo quanto necessario all'assistenza), diritto di cancellazione gestibile con procedura di anonimizzazione (sostituzione campi PII mantenendo lo storico statistico), registro dei trattamenti da mantenere separatamente.

## 2.5 Ambienti e CI/CD

- **Repository GitHub** con branch `main` (produzione) e branch di feature.
- **Vercel**: deploy automatico di `apps/web` ad ogni push su `main` (preview deploy sulle pull request).
- **Supabase**: un progetto per ambiente (sviluppo/produzione), migrazioni SQL versionate in `supabase/migrations` e applicate con `supabase db push` o dalla dashboard.
- **Variabili d'ambiente**: gestite nei secret di Vercel/Supabase, mai committate (vedi `.env.example`).
