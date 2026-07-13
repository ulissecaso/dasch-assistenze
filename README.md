# Dasch Gestione Assistenze

Sistema di gestione e monitoraggio automatizzato delle pratiche di assistenza post-vendita. Sostituisce il controllo manuale basato sui CSV esportati dal gestionale, mantenendo il gestionale invariato e preparando il terreno per una futura integrazione via API.

Stack: **Next.js (React) + Supabase (PostgreSQL/Auth/Storage) + Vercel**, scelto per essere immediatamente operativo con gli strumenti già in uso (GitHub, Supabase, Vercel).

## Struttura del progetto

```
dasch-assistenze/
├── docs/                        # analisi funzionale, tecnica, schema DB, diagrammi, wireframe, roadmap
├── supabase/
│   ├── migrations/              # schema DB completo (SQL), automazioni, viste KPI
│   └── functions/check-sla/     # Edge Function: motore SLA/alert schedulato
├── scripts/import-csv/          # importatore CSV -> Supabase, testato sul file reale fornito
├── scraper/                     # template Playwright per download automatico CSV (solo se necessario)
└── apps/web/                    # applicazione Next.js: dashboard direzione/operatore, pratica, admin
```

## Da dove iniziare

1. Leggere `docs/01-analisi-funzionale.md` e `docs/02-analisi-tecnica-e-architettura.md`.
2. Creare un progetto su [supabase.com](https://supabase.com), applicare le migrazioni in `supabase/migrations/` (SQL editor o `supabase db push`).
3. Popolare `regole_assegnazione` con gli operatori reali (vedi `docs/06-motore-automazioni-esempi.md`).
4. Configurare `apps/web/.env.example` → `.env.local` con le chiavi del progetto Supabase.
5. `cd apps/web && npm install && npm run dev` per avviare la webapp in locale.
6. Testare l'importazione con i propri CSV: `cd scripts/import-csv && npm install && npm run import -- "/percorso/file.csv"` (richiede `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` in ambiente).
7. Deploy: collegare il repository GitHub a Vercel (cartella `apps/web` come root del progetto Vercel).

## Verifica già effettuata in questa consegna

Lo script di importazione (`scripts/import-csv`) è stato eseguito ed è stato validato contro il file CSV reale fornito (`Piano di carico - Vamart.csv`, 6.016 righe): riconosce correttamente 2.281 pratiche distinte, 1.367 clienti, 73 fornitori, e segnala 8 righe con cliente mancante nel dato sorgente (log in `importazioni_csv_errori`, senza bloccare l'importazione). Il dettaglio del test è in `scripts/import-csv/test-parsing.mjs`.

## Multi-brand: Arredamenti Cinquegrana + Master Mobili

Il sistema gestisce entrambi i brand nello stesso database, con lo stesso workflow e gli stessi operatori (abilitabili su uno o entrambi). Per attivare Master Mobili dopo aver applicato `supabase/migrations/0011_multi_brand.sql`:

1. Aggiungere il secret GitHub Actions `VAMART_URL_MASTERMOBILI` (`https://mastermobili20250616103641.azurewebsites.net/Account/Login`) — le credenziali (`VAMART_USER`/`VAMART_PASS`) sono le stesse gia' in uso per Cinquegrana.
2. Abilitare gli operatori che devono lavorare anche Master Mobili in `operatore_brand` (dal pannello admin quando disponibile, nel frattempo via SQL editor — vedi esempio in fondo a `0011_multi_brand.sql`).
3. Se serve un caricamento storico iniziale (come fatto per Cinquegrana con `Piano di carico - Vamart.csv`), usare `BRAND_CODICE=MASTERMOBILI node scripts/import-csv/bulkImportVamartCsv.mjs <file.csv>`.

**Ancora da fare (non incluso in questa modifica):** la dashboard/monitor non distingue ancora visivamente i due brand (nessun badge/filtro colore), e l'intake email delle segnalazioni legge oggi una sola casella IMAP (quella di Cinquegrana) — se Master Mobili riceve le segnalazioni su una casella diversa, va deciso come instradarle prima di implementarlo.

## Documentazione completa

Vedi la cartella `docs/` per: analisi funzionale (1), analisi tecnica e architettura (2), schema database (3), diagrammi di flusso (4), wireframe (5), esempi di automazioni (6), piano di sviluppo a milestone (7), piano evolutivo per l'integrazione API (8), guida allo scraper automatico (9).
