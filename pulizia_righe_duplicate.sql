-- Pulizia una tantum dei duplicati accumulati in pratica_righe a causa del
-- bug di paginazione corretto il 06/08/2026 (vedi commit "Fix: pagina le
-- query di righe/fasi esistenti negli import CSV"). Per ogni combinazione
-- (pratica_id, codice_articolo, descrizione) tiene solo la riga piu'
-- recente (updated_at piu' alto) ed elimina le altre.

-- STEP 1 (sicuro, sola lettura): quante righe verrebbero eliminate.
-- Esegui questa per prima e guarda il numero prima di procedere.
with duplicati as (
  select id,
         row_number() over (
           partition by pratica_id, codice_articolo, descrizione
           order by updated_at desc nulls last, id desc
         ) as rn
  from pratica_righe
)
select count(*) as righe_da_eliminare
from duplicati
where rn > 1;

-- STEP 2 (distruttivo): esegui SOLO dopo aver controllato il numero sopra
-- e confermato che ha senso. Cancella tutte le righe duplicate, tenendo
-- per ciascun gruppo solo quella con l'updated_at piu' recente.
-- with duplicati as (
--   select id,
--          row_number() over (
--            partition by pratica_id, codice_articolo, descrizione
--            order by updated_at desc nulls last, id desc
--          ) as rn
--   from pratica_righe
-- )
-- delete from pratica_righe
-- where id in (select id from duplicati where rn > 1);
