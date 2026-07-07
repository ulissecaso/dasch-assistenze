-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — funzioni di supporto per la dashboard direzione
-- =====================================================================

-- Pratiche aperte/in ritardo/chiuse (ultimi 30gg) per operatore
create or replace function pratiche_per_operatore()
returns table (
  operatore_id uuid,
  operatore_nome text,
  aperte bigint,
  in_ritardo bigint,
  chiuse_30gg bigint
) as $$
  select
    u.id as operatore_id,
    u.nome || ' ' || u.cognome as operatore_nome,
    count(*) filter (where p.stato_generale not in ('chiusa','annullata')) as aperte,
    count(distinct r.pratica_id) as in_ritardo,
    count(*) filter (where p.stato_generale = 'chiusa' and p.data_chiusura_effettiva > now() - interval '30 days') as chiuse_30gg
  from utenti u
  left join pratiche p on p.operatore_assegnato_id = u.id
  left join v_pratiche_in_ritardo r on r.operatore_assegnato_id = u.id
  where u.ruolo = 'operatore' and u.attivo = true
  group by u.id, u.nome, u.cognome
  order by operatore_nome;
$$ language sql stable;

-- Tempo medio (in giorni) tra apertura e chiusura pratica
create or replace function tempo_medio_chiusura_giorni()
returns numeric as $$
  select round(avg(extract(epoch from (data_chiusura_effettiva - data_apertura)) / 86400)::numeric, 1)
  from pratiche
  where stato_generale = 'chiusa' and data_chiusura_effettiva is not null;
$$ language sql stable;
