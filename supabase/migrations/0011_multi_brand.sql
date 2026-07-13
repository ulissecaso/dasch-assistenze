-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Multi-brand: Arredamenti Cinquegrana + Master Mobili
-- =====================================================================
-- Stessi operatori, stesso workflow, stesso database: il brand diventa una
-- dimensione trasversale ai dati, non un secondo sistema parallelo. Master
-- Mobili usa lo stesso gestionale Vamart (stesse credenziali, indirizzo
-- diverso), quindi importer/scraper restano gli stessi, parametrizzati.
--
-- Compatibilita' con il codice applicativo non ancora aggiornato: brand_id
-- ha un DEFAULT che punta a Cinquegrana su entrambe le tabelle (clienti,
-- pratiche). Finche' import/scraper/app non vengono aggiornati per passare
-- esplicitamente il brand, tutto continua a comportarsi esattamente come
-- prima (tutto su Cinquegrana). Questo permette di applicare la migrazione
-- PRIMA di deployare il codice aggiornato, senza rompere nulla nel mezzo.
--
-- Da fare DOPO aver applicato questa migrazione:
--  1. Deployare le versioni aggiornate di scripts/import-csv/*.mjs e dello
--     scraper (vedi commit "multi-brand: importer + scraper + workflow").
--  2. Aggiungere il secret GitHub Actions VAMART_URL_MASTERMOBILI
--     (https://mastermobili20250616103641.azurewebsites.net/Account/Login).
--  3. Popolare operatore_brand per gli operatori che devono lavorare anche
--     Master Mobili (di default, alla creazione, tutti restano abilitati
--     solo su Cinquegrana, backfill sotto).
--  4. Se le regole di assegnazione di Master Mobili devono differire da
--     quelle di Cinquegrana, aggiungere righe in regole_assegnazione con
--     brand_id valorizzato (una riga con brand_id NULL vale per entrambi).
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. TABELLA BRANDS
-- ---------------------------------------------------------------------
create table if not exists brands (
    id uuid primary key default uuid_generate_v4(),
    codice text not null unique,           -- 'CINQUEGRANA' | 'MASTERMOBILI'
    nome text not null,
    colore text not null default '#6366f1', -- badge identificativo in dashboard/monitor
    attivo boolean not null default true,
    created_at timestamptz not null default now()
);
comment on table brands is 'Brand gestiti dalla piattaforma (oggi: Arredamenti Cinquegrana, Master Mobili). Ogni cliente e ogni pratica appartengono a un brand.';

insert into brands (codice, nome, colore) values
  ('CINQUEGRANA', 'Arredamenti Cinquegrana', '#1E3A8A'),
  ('MASTERMOBILI', 'Master Mobili', '#B45309')
on conflict (codice) do nothing;

create or replace function brand_cinquegrana_id()
returns uuid as $$
  select id from brands where codice = 'CINQUEGRANA';
$$ language sql stable;
comment on function brand_cinquegrana_id() is 'Id del brand storico (Cinquegrana): usato come default di compatibilita'' per il codice applicativo non ancora aggiornato al multi-brand.';

-- ---------------------------------------------------------------------
-- 2. BRAND_ID SU CLIENTI E PRATICHE (additivo, con default di compatibilita')
-- ---------------------------------------------------------------------
alter table clienti add column if not exists brand_id uuid references brands(id);
update clienti set brand_id = brand_cinquegrana_id() where brand_id is null;
alter table clienti alter column brand_id set not null;
alter table clienti alter column brand_id set default brand_cinquegrana_id();
create index if not exists idx_clienti_brand on clienti(brand_id);

alter table pratiche add column if not exists brand_id uuid references brands(id);
update pratiche set brand_id = brand_cinquegrana_id() where brand_id is null;
alter table pratiche alter column brand_id set not null;
alter table pratiche alter column brand_id set default brand_cinquegrana_id();
create index if not exists idx_pratiche_brand on pratiche(brand_id);

-- codice_commissione era unico globalmente: due istanze Vamart separate
-- (una per brand) possono pero' generare lo stesso numero di commissione,
-- quindi l'unicita' deve valere per brand, non piu' in assoluto. Tutte le
-- righe esistenti sono gia' su Cinquegrana: l'unicita' composita non rompe
-- nulla di gia' presente.
alter table pratiche drop constraint if exists pratiche_codice_commissione_key;
create unique index if not exists idx_pratiche_brand_codice_commissione on pratiche(brand_id, codice_commissione);

-- Stesso discorso per codice_esterno dei clienti (predisposto per il
-- matching futuro via API): unicita' per brand.
drop index if exists idx_clienti_codice_esterno;
create unique index if not exists idx_clienti_brand_codice_esterno on clienti(brand_id, codice_esterno) where codice_esterno is not null;

-- Traccia anche a quale brand appartiene ogni sessione di importazione CSV
-- (nullable: le importazioni gia' registrate restano senza brand esplicito,
-- si presume Cinquegrana in assenza di indicazione diversa).
alter table importazioni_csv add column if not exists brand_id uuid references brands(id);

-- ---------------------------------------------------------------------
-- 3. OPERATORE_BRAND — su quali brand puo' lavorare ciascun operatore
-- ---------------------------------------------------------------------
create table if not exists operatore_brand (
    operatore_id uuid not null references utenti(id) on delete cascade,
    brand_id uuid not null references brands(id) on delete cascade,
    attivo boolean not null default true,
    created_at timestamptz not null default now(),
    primary key (operatore_id, brand_id)
);
comment on table operatore_brand is 'Abilitazione di ciascun operatore ai brand su cui puo'' lavorare le pratiche. Un operatore puo'' essere abilitato solo su Cinquegrana, solo su Master Mobili, o su entrambi.';

-- Backfill: tutti gli utenti esistenti restano abilitati su Cinquegrana
-- (comportamento identico a prima). Per abilitare qualcuno anche su Master
-- Mobili, aggiungere una riga con il brand_id di MASTERMOBILI dal pannello
-- admin (o via SQL: vedi esempio in fondo a questo file).
insert into operatore_brand (operatore_id, brand_id)
select u.id, b.id
from utenti u
cross join brands b
where b.codice = 'CINQUEGRANA'
on conflict do nothing;

alter table operatore_brand enable row level security;
drop policy if exists "lettura_temp_operatore_brand" on operatore_brand;
create policy "lettura_temp_operatore_brand" on operatore_brand for select using (true);

alter table brands enable row level security;
drop policy if exists "lettura_temp_brands" on brands;
create policy "lettura_temp_brands" on brands for select using (true);

-- ---------------------------------------------------------------------
-- 4. REGOLE DI ASSEGNAZIONE: brand_id nullable = valida per tutti i brand
-- ---------------------------------------------------------------------
alter table regole_assegnazione add column if not exists brand_id uuid references brands(id);
comment on column regole_assegnazione.brand_id is 'NULL = regola valida per tutti i brand (caso attuale: stesse regole per Cinquegrana e Master Mobili). Valorizzare per creare un''eccezione specifica di un brand: una regola con brand_id impostato vince su una equivalente generica.';

-- ---------------------------------------------------------------------
-- 5. ASSEGNAZIONE AUTOMATICA: ora considera anche il brand della pratica.
--    Nuovo overload (stesso pattern gia' usato in 0010 per aggiungere
--    tipo_pratica): la versione precedente resta a 2 argomenti ma non e'
--    piu' referenziata da nessun trigger, non causa comportamenti diversi.
-- ---------------------------------------------------------------------
create or replace function assegna_operatore_automatico(
  p_cliente_nome text,
  p_tipo_pratica text default 'assistenza',
  p_brand_id uuid default null
)
returns uuid as $$
declare
  v_iniziale char(1);
  v_operatore_id uuid;
begin
  v_iniziale := upper(substring(trim(p_cliente_nome) from 1 for 1));

  select ra.operatore_id into v_operatore_id
  from regole_assegnazione ra
  where ra.attiva = true
    and ra.criterio = 'iniziale_cognome'
    and ra.tipo_pratica = p_tipo_pratica
    and (ra.brand_id is null or ra.brand_id = p_brand_id)
    and v_iniziale between upper(ra.valore_da) and upper(ra.valore_a)
  order by (ra.brand_id is not null) desc, ra.priorita asc  -- una regola specifica del brand vince su una generica
  limit 1;

  return v_operatore_id; -- null se nessuna regola corrisponde (assegnazione manuale)
end;
$$ language plpgsql stable;

create or replace function trg_fn_assegna_operatore()
returns trigger as $$
declare
  v_nome_cliente text;
  v_abilitato boolean;
begin
  select (valore::text)::boolean into v_abilitato
  from configurazioni where chiave = 'regole_assegnazione_attive';

  if coalesce(v_abilitato, true) and new.operatore_assegnato_id is null then
    select nome_completo into v_nome_cliente from clienti where id = new.cliente_id;
    new.operatore_assegnato_id := assegna_operatore_automatico(v_nome_cliente, coalesce(new.tipo, 'assistenza'), new.brand_id);
  end if;

  return new;
end;
$$ language plpgsql;
-- Il trigger trg_pratiche_assegna_operatore (creato in 0002) punta gia' a
-- questa funzione per nome: nessuna modifica al trigger stesso necessaria.

-- ---------------------------------------------------------------------
-- 6. RLS: un operatore vede/aggiorna le proprie pratiche solo se e'
--    abilitato sul brand di quella pratica (difesa in profondita': in
--    pratica l'assegnazione automatica gia' rispetta il brand, questo
--    copre anche assegnazioni manuali o accessi diretti via URL).
-- ---------------------------------------------------------------------
drop policy if exists "operatore_vede_proprie_pratiche" on pratiche;
create policy "operatore_vede_proprie_pratiche" on pratiche
  for select using (
    (
      operatore_assegnato_id = auth.uid()
      and exists (
        select 1 from operatore_brand ob
        where ob.operatore_id = auth.uid() and ob.brand_id = pratiche.brand_id and ob.attivo = true
      )
    )
    or exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo in ('admin','responsabile'))
  );

drop policy if exists "operatore_aggiorna_proprie_pratiche" on pratiche;
create policy "operatore_aggiorna_proprie_pratiche" on pratiche
  for update using (
    (
      operatore_assegnato_id = auth.uid()
      and exists (
        select 1 from operatore_brand ob
        where ob.operatore_id = auth.uid() and ob.brand_id = pratiche.brand_id and ob.attivo = true
      )
    )
    or exists (select 1 from utenti u where u.id = auth.uid() and u.ruolo in ('admin','responsabile'))
  );

-- =====================================================================
-- Esempio (da NON eseguire automaticamente): abilitare un operatore anche
-- su Master Mobili dal SQL editor, in attesa che il pannello admin abbia
-- una UI dedicata:
--
-- insert into operatore_brand (operatore_id, brand_id)
-- select '<uuid-operatore>', id from brands where codice = 'MASTERMOBILI'
-- on conflict do nothing;
-- =====================================================================
