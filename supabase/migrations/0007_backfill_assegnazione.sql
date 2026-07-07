-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Backfill assegnazione operatore
-- =====================================================================
-- Le pratiche importate dal CSV prima che esistessero le regole di
-- assegnazione (Jessica A-G, Simona H-Z) sono rimaste con
-- operatore_assegnato_id nullo: il trigger automatico si applica solo
-- alle pratiche NUOVE da quel momento in poi, non retroattivamente.
--
-- Questo script riusa la stessa funzione assegna_operatore_automatico()
-- già usata dal trigger (definita in 0002_automazioni.sql), così la
-- logica di assegnazione resta un'unica fonte di verità. Tocca solo le
-- pratiche non ancora assegnate e non chiuse/annullate: non sovrascrive
-- mai un'assegnazione manuale già presente.
-- ---------------------------------------------------------------------

update pratiche p
set operatore_assegnato_id = assegna_operatore_automatico(c.nome_completo)
from clienti c
where c.id = p.cliente_id
  and p.operatore_assegnato_id is null
  and p.stato_generale not in ('chiusa', 'annullata');
