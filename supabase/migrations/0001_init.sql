-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Schema iniziale database (PostgreSQL/Supabase)
-- =====================================================================
-- Convenzioni:
--  - tutte le tabelle hanno id uuid, created_at/updated_at
--  - "pratica" = commissione di assistenza (chiave gestionale: codice_commissione)
--  - "pratica_riga" = singola riga/articolo della commissione (dal CSV Piano di carico)
--  - storicizzazione: ogni modifica rilevante viene tracciata in *_storico
-- =====================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- 1. UTENTI / RUOLI
-- ---------------------------------------------------------------------
create table utenti (
    id uuid primary key references auth.users(id) on delete cascade,
    nome text not null,
    cognome text not null,
    email text not null unique,
    ruolo text not null check (ruolo in ('admin','responsabile','operatore')) default 'operatore',
    telefono text,
    attivo boolean not null default true,
    colore_badge text,
    iniziali text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
comment on table utenti is 'Profilo applicativo di ogni utente (admin, responsabile, operatore).';

-- ---------------------------------------------------------------------
-- 2. CLIENTI
-- ---------------------------------------------------------------------
create table clienti (
    id uuid primary key default uuid_generate_v4(),
    nome_completo text not null,
    telefono text,
    email text,
    indirizzo text,
    citta text,
    cap text,
    note text,
    codice_esterno text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index idx_clienti_nome on clienti using gin (to_tsvector('italian', nome_completo));
create unique index idx_clienti_codice_esterno on clienti(codice_esterno) where codice_esterno is not null;

-- ---------------------------------------------------------------------
-- 3. FORNITORI
-- ---------------------------------------------------------------------
create table fornitori (
    id uuid primary key default uuid_generate_v4(),
    ragione_sociale text not null unique,
    telefono text,
    email text,
    referente text,
    note text,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 4. FASI DI WORKFLOW (master, configurabile da admin)
-- ---------------------------------------------------------------------
create table fasi_workflow (
    id uuid primary key default uuid_generate_v4(),
    codice text not null unique,
    nome text not null,
    ordine int not null,
    sla_ore_default int,
    obbligatoria boolean not null default true,
    attiva boolean not null default true,
    created_at timestamptz not null default now()
);
comment on table fasi_workflow is 'Elenco configurabile delle fasi operative di una pratica.';

-- ---------------------------------------------------------------------
-- 5. PRATICHE (commesse / commissioni di assistenza)
-- ---------------------------------------------------------------------
create table pratiche (
    id uuid primary key default uuid_generate_v4(),
    codice_commissione text not null unique,
    cliente_id uuid not null references clienti(id),
    tipo text,
    categoria text,
    descrizione text,
    canale_origine text not null default 'csv' check (canale_origine in ('app','email','manuale','csv','api')),
    stato_generale text not null default 'aperta' check (stato_generale in ('aperta','in_lavorazione','in_ritardo','sospesa','chiusa','annullata')),
    priorita text not null default 'normale' check (priorita in ('bassa','normale','alta','urgente')),
    operatore_assegnato_id uuid references utenti(id),
    data_apertura timestamptz not null default now(),
    data_consegna_prevista date,
    data_chiusura_effettiva timestamptz,
    fonte_dati text not null default 'csv' check (fonte_dati in ('csv','api')),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index idx_pratiche_stato on pratiche(stato_generale);
create index idx_pratiche_operatore on pratiche(operatore_assegnato_id);
create index idx_pratiche_cliente on pratiche(cliente_id);
comment on table pratiche is 'Entità centrale: una pratica = una commissione di assistenza/completamento.';

-- ---------------------------------------------------------------------
-- 6. RIGHE PRATICA (dettaglio articoli — mappa 1:1 le righe del CSV "Piano di carico")
-- ---------------------------------------------------------------------
create table pratica_righe (
    id uuid primary key default uuid_generate_v4(),
    pratica_id uuid not null references pratiche(id) on delete cascade,
    fornitore_id uuid references fornitori(id),
    codice_articolo text,
    descrizione text,
    quantita_venduta numeric(12,2) default 0,
    listino numeric(12,2) default 0,
    quantita_ordinata numeric(12,2) default 0,
    data_ordine date,
    conferma_ordine text,
    rif_conferma text,
    pag_azienda text,
    data_consegna_prevista date,
    quantita_giacente numeric(12,2) default 0,
    data_carico date,
    quantita_consegnata numeric(12,2) default 0,
    data_consegna date,
    status_riga text check (status_riga in ('Da ordinare','Ordinato','In giacenza','Parzialmente consegnato','Consegnato')),
    magazzino text,
    ubicazione text,
    riga_hash text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index idx_righe_pratica on pratica_righe(pratica_id);
create index idx_righe_status on pratica_righe(status_riga);

-- ---------------------------------------------------------------------
-- 7. STATO FASI PER PRATICA
-- ---------------------------------------------------------------------
create table pratica_fasi (
    id uuid primary key default uuid_generate_v4(),
    pratica_id uuid not null references pratiche(id) on delete cascade,
    fase_id uuid not null references fasi_workflow(id),
    stato text not null default 'da_iniziare' check (stato in ('da_iniziare','in_corso','completata','in_ritardo','saltata')),
    data_prevista timestamptz,
    data_effettiva timestamptz,
    responsabile_id uuid references utenti(id),
    note text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique(pratica_id, fase_id)
);
create index idx_pratica_fasi_pratica on pratica_fasi(pratica_id);
create index idx_pratica_fasi_stato on pratica_fasi(stato);

-- ---------------------------------------------------------------------
-- 8. STORICO MODIFICHE
-- ---------------------------------------------------------------------
create table storico_modifiche (
    id uuid primary key default uuid_generate_v4(),
    entita text not null,
    entita_id uuid not null,
    campo text not null,
    valore_precedente text,
    valore_nuovo text,
    origine text not null default 'utente' check (origine in ('utente','importazione_csv','importazione_api','automazione')),
    modificato_da uuid references utenti(id),
    modificato_il timestamptz not null default now()
);
create index idx_storico_entita on storico_modifiche(entita, entita_id);

-- ---------------------------------------------------------------------
-- 9. ALLEGATI
-- ---------------------------------------------------------------------
create table allegati (
    id uuid primary key default uuid_generate_v4(),
    pratica_id uuid not null references pratiche(id) on delete cascade,
    pratica_fase_id uuid references pratica_fasi(id),
    nome_file text not null,
    percorso_storage text not null,
    tipo_mime text,
    dimensione_bytes bigint,
    caricato_da uuid references utenti(id),
    created_at timestamptz not null default now()
);
create index idx_allegati_pratica on allegati(pratica_id);

-- ---------------------------------------------------------------------
-- 10. REGOLE DI ASSEGNAZIONE
-- ---------------------------------------------------------------------
create table regole_assegnazione (
    id uuid primary key default uuid_generate_v4(),
    nome text not null,
    criterio text not null default 'iniziale_cognome' check (criterio in ('iniziale_cognome','categoria','zona','fornitore','manuale')),
    valore_da text,
    valore_a text,
    operatore_id uuid not null references utenti(id),
    priorita int not null default 100,
    attiva boolean not null default true,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
create index idx_regole_assegnazione_attive on regole_assegnazione(attiva, priorita);

-- ---------------------------------------------------------------------
-- 11. REGOLE ALERT / SLA
-- ---------------------------------------------------------------------
create table regole_alert (
    id uuid primary key default uuid_generate_v4(),
    nome text not null,
    fase_id uuid references fasi_workflow(id),
    tipo_condizione text not null check (tipo_condizione in ('fase_non_iniziata_entro','fase_non_completata_entro','pratica_ferma_da','ritardo_su_data_prevista')),
    soglia_valore int not null,
    soglia_unita text not null default 'ore' check (soglia_unita in ('ore','giorni')),
    livello text not null default 'alert' check (livello in ('info','alert','escalation')),
    destinatari_ruolo text[] default array['responsabile'],
    attiva boolean not null default true,
    created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- 12. NOTIFICHE
-- ---------------------------------------------------------------------
create table notifiche (
    id uuid primary key default uuid_generate_v4(),
    utente_id uuid not null references utenti(id),
    pratica_id uuid references pratiche(id),
    regola_alert_id uuid references regole_alert(id),
    tipo text not null,
    titolo text not null,
    messaggio text not null,
    letta boolean not null default false,
    canale text not null default 'app' check (canale in ('app','email','push')),
    created_at timestamptz not null default now()
);
create index idx_notifiche_utente on notifiche(utente_id, letta);

-- ---------------------------------------------------------------------
-- 13. IMPORTAZIONI CSV
-- ---------------------------------------------------------------------
create table importazioni_csv (
    id uuid primary key default uuid_generate_v4(),
    nome_file text not null,
    origine text not null default 'manuale' check (origine in ('manuale','scraper_automatico','api')),
    righe_totali int default 0,
    righe_nuove int default 0,
    righe_aggiornate int default 0,
    righe_invariate int default 0,
    righe_errore int default 0,
    stato text not null default 'in_corso' check (stato in ('in_corso','completata','completata_con_errori','fallita')),
    iniziata_il timestamptz not null default now(),
    completata_il timestamptz,
    eseguita_da uuid references utenti(id)
);

create table importazioni_csv_errori (
    id uuid primary key default uuid_generate_v4(),
    importazione_id uuid not null references importazioni_csv(id) on delete cascade,
    numero_riga int,
    messaggio_errore text not null,
    dato_grezzo jsonb,
    created_at timestamptz not null default now()
);
create index idx_import_errori_import on importazioni_csv_errori(importazione_id);

-- ---------------------------------------------------------------------
-- 14. LOG ATTIVITÀ
-- ---------------------------------------------------------------------
create table log_attivita (
    id uuid primary key default uuid_generate_v4(),
    utente_id uuid references utenti(id),
    entita text,
    entita_id uuid,
    azione text not null,
    dettagli jsonb,
    ip text,
    user_agent text,
    created_at timestamptz not null default now()
);
create index idx_log_attivita_utente on log_attivita(utente_id, created_at desc);

-- ---------------------------------------------------------------------
-- 15. CONFIGURAZIONI DI SISTEMA (key-value)
-- ---------------------------------------------------------------------
create table configurazioni (
    chiave text primary key,
    valore jsonb not null,
    descrizione text,
    modificabile boolean not null default true,
    updated_at timestamptz not null default now(),
    updated_by uuid references utenti(id)
);

-- =====================================================================
-- TRIGGER: updated_at automatico
-- =====================================================================
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger trg_utenti_updated before update on utenti for each row execute function set_updated_at();
create trigger trg_clienti_updated before update on clienti for each row execute function set_updated_at();
create trigger trg_pratiche_updated before update on pratiche for each row execute function set_updated_at();
create trigger trg_righe_updated before update on pratica_righe for each row execute function set_updated_at();
create trigger trg_pratica_fasi_updated before update on pratica_fasi for each row execute function set_updated_at();
create trigger trg_regole_assegnazione_updated before update on regole_assegnazione for each row execute function set_updated_at();

-- =====================================================================
-- SEED: fasi di workflow di default (da spec)
-- =====================================================================
insert into fasi_workflow (codice, nome, ordine, sla_ore_default) values
 ('ricezione','Ricezione segnalazione',10,4),
 ('presa_in_carico','Presa in carico',20,24),
 ('apertura_pratica','Apertura pratica',30,24),
 ('creazione_commissione','Creazione commissione di assistenza',40,72),
 ('ordine_ricambi','Invio ordine ricambi',50,120),
 ('arrivo_merce','Arrivo merce in deposito',60,720),
 ('preparazione_intervento','Preparazione intervento',70,48),
 ('consegna_materiale','Consegna materiale',80,72),
 ('chiusura_assistenza','Chiusura assistenza',90,24);

insert into configurazioni (chiave, valore, descrizione) values
 ('regole_assegnazione_attive', 'true', 'Abilita motore di assegnazione automatica'),
 ('formato_data_import', '"DD/MM/YYYY"', 'Formato data atteso nei CSV importati'),
 ('fonte_dati_attiva', '"csv"', 'Modulo di importazione attivo: csv oppure api');

-- =====================================================================
-- ROW LEVEL SECURITY (base — da raffinare in produzione)
-- =====================================================================
alter table pratiche enable row level security;
alter table pratica_righe enable row level security;
alter table pratica_fasi enable row level security;
alter table notifiche enable row level security;
alter table allegati enable row level security;

create policy "admin_responsabile_full_access_pratiche" on pratiche
  for all using (
    exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo in ('admin','responsabile'))
  );

create policy "operatore_vede_proprie_pratiche" on pratiche
  for select using (
    operatore_assegnato_id = auth.uid()
    or exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo in ('admin','responsabile'))
  );

create policy "operatore_aggiorna_proprie_pratiche" on pratiche
  for update using (
    operatore_assegnato_id = auth.uid()
    or exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo in ('admin','responsabile'))
  );

create policy "notifiche_solo_proprie" on notifiche
  for select using (utente_id = auth.uid());
