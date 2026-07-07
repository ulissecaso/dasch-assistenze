-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Modulo ricezione segnalazioni via email
-- =====================================================================
-- Le segnalazioni arrivano su una casella IMAP (servizioclienti@...) da due
-- fonti con formati diversi: l'App (testo semplice) e il form del sito
-- (email HTML). Un cron job legge la casella periodicamente e per ogni
-- messaggio crea o aggiorna una pratica.
--
-- codice_commissione_riferimento: il numero di commissione così come lo
-- conosce il cliente (es. "340/23"), usato per ritrovare la pratica giusta.
-- codice_commissione resta la chiave univoca reale: per il primo intervento
-- su una commissione coincide con il riferimento; se in futuro arriva una
-- NUOVA segnalazione per una commissione la cui pratica precedente è già
-- chiusa, si crea una pratica separata con un suffisso (es. "340/23-B") così
-- i due interventi restano distinti e l'importatore CSV (che matcha per
-- codice_commissione esatto) continua a funzionare senza modifiche.
-- =====================================================================

alter table pratiche add column if not exists codice_commissione_riferimento text;
update pratiche set codice_commissione_riferimento = codice_commissione where codice_commissione_riferimento is null;
alter table pratiche alter column codice_commissione_riferimento set not null;
create index if not exists idx_pratiche_commissione_riferimento on pratiche(codice_commissione_riferimento);

-- ---------------------------------------------------------------------
-- IMPORTAZIONI EMAIL (audit + idempotenza)
-- ---------------------------------------------------------------------
create table if not exists importazioni_email (
    id uuid primary key default uuid_generate_v4(),
    message_id text not null unique,
    mittente text,
    oggetto text,
    ricevuta_il timestamptz,
    formato_rilevato text not null default 'sconosciuto' check (formato_rilevato in ('app','sito','sconosciuto')),
    esito text not null check (esito in ('creata','aggiornata','ignorata','errore')),
    pratica_id uuid references pratiche(id),
    messaggio_errore text,
    dati_estratti jsonb,
    corpo_grezzo text,
    created_at timestamptz not null default now()
);
create index if not exists idx_import_email_pratica on importazioni_email(pratica_id);
create index if not exists idx_import_email_esito on importazioni_email(esito, created_at desc);

comment on table importazioni_email is 'Log di ogni messaggio letto dalla casella segnalazioni: garantisce di non processare due volte la stessa mail (message_id univoco) e traccia gli errori di formato.';
