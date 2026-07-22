-- =====================================================================
-- DASCH GESTIONE ASSISTENZE — Migliora l'estrazione del cognome per
-- l'assegnazione automatica (criterio 'iniziale_cognome')
-- =====================================================================
-- PROBLEMA RISCONTRATO: assegna_operatore_automatico() prende sempre la
-- prima lettera della PRIMA PAROLA di clienti.nome_completo come iniziale
-- del cognome (vedi 0002_automazioni.sql / 0011_multi_brand.sql). Funziona
-- quando il nome e' salvato come "Cognome Nome" (il formato piu' comune nei
-- dati del gestionale, es. "Proietti Martina"), ma smista all'operatore
-- sbagliato quando e' salvato come "Nome Cognome" (es. "Noemi Gambino": la
-- pratica 1002/26 e' finita su Simona invece che su Jessica, che gestisce
-- A-G, perche' "Gambino" inizia per G ma "Noemi" inizia per N) oppure quando
-- il nome contiene piu' persone (es. "Rodolfo e Maria d'agostino -
-- caterino": pratica 1011/26, stesso problema).
--
-- Nota: lib/email/elaboraSegnalazione.ts ha gia' un correttivo equivalente
-- (riordinaCognomeNome) ma si applica solo ai NUOVI clienti creati da una
-- segnalazione email/app, non ai clienti importati da CSV (che sono la
-- maggioranza) e non retroattivamente a chi era gia' a sistema. Questa
-- migrazione porta la stessa idea nella funzione centrale usata da TUTTI i
-- canali (CSV, email, manuale), cosi' resta un'unica fonte di verita'.
--
-- EURISTICA (non perfetta, nessun parser di nomi lo e' senza un vero
-- servizio di riconoscimento nomi): tokenizziamo il nome, scartiamo
-- congiunzioni pure ("e", "&", "-"), e guardiamo prima parola e ultima
-- parola. Se la prima e' un nome di battesimo comune e l'ultima NO, allora
-- il cognome e' probabilmente l'ultima parola (formato "Nome Cognome"). In
-- ogni altro caso (compreso quando non sappiamo decidere) manteniamo il
-- comportamento storico: prima parola = cognome. Questo significa che il
-- comportamento per il caso piu' comune ("Cognome Nome") NON CAMBIA: cambia
-- solo per i casi in cui oggi sappiamo che sbaglia.
--
-- La lista di nomi comuni e' volutamente ampia ma non esaustiva: casi limite
-- continueranno a richiedere una correzione manuale dall'admin (invariato
-- rispetto a oggi), ma dovrebbero diventare più rari.
-- =====================================================================

create table if not exists nomi_propri_comuni (
  nome text primary key
);
comment on table nomi_propri_comuni is 'Nomi di battesimo italiani comuni, usati da estrai_iniziale_cognome() per capire se la prima parola di un nome cliente e'' un nome proprio o probabilmente un cognome. Modificabile: aggiungere/togliere righe aggiorna subito il comportamento, senza bisogno di una nuova migrazione.';

insert into nomi_propri_comuni (nome) values
  ('mario'),('giuseppe'),('giovanni'),('francesco'),('antonio'),('alessandro'),('andrea'),('marco'),('luca'),('matteo'),
  ('davide'),('simone'),('federico'),('lorenzo'),('riccardo'),('roberto'),('stefano'),('paolo'),('pietro'),('luigi'),
  ('carlo'),('franco'),('gianni'),('giorgio'),('massimo'),('claudio'),('fabio'),('sergio'),('angelo'),('vincenzo'),
  ('salvatore'),('domenico'),('michele'),('raffaele'),('vittorio'),('alberto'),('emanuele'),('daniele'),('gabriele'),('nicola'),
  ('filippo'),('tommaso'),('leonardo'),('edoardo'),('cristian'),('cristiano'),('samuele'),('manuel'),('ivan'),('ivano'),
  ('dario'),('mauro'),('maurizio'),('renato'),('rinaldo'),('romano'),('rodolfo'),('gerardo'),('gennaro'),('ciro'),
  ('pasquale'),('umberto'),('guido'),('aldo'),('arnaldo'),('bruno'),('dino'),('ezio'),('ettore'),('enzo'),
  ('enrico'),('ernesto'),('elio'),('walter'),('valerio'),('valentino'),('ugo'),('tiziano'),('silvio'),('sandro'),
  ('rocco'),('remo'),('ottavio'),('orlando'),('oscar'),('nino'),('nunzio'),('natale'),('mirko'),('nicolo'),
  ('niccolo'),('gaetano'),('donato'),('cosimo'),('generoso'),('pierluigi'),('pierpaolo'),('giampiero'),('giancarlo'),('gianfranco'),
  ('maria'),('anna'),('giulia'),('francesca'),('chiara'),('sara'),('laura'),('elena'),('valentina'),('martina'),
  ('sofia'),('giorgia'),('alessia'),('federica'),('silvia'),('alice'),('marta'),('elisa'),('ilaria'),('roberta'),
  ('simona'),('monica'),('cristina'),('paola'),('patrizia'),('daniela'),('barbara'),('claudia'),('angela'),('rosa'),
  ('rosanna'),('antonella'),('teresa'),('carla'),('carmela'),('concetta'),('filomena'),('gabriella'),('giuseppina'),('immacolata'),
  ('lucia'),('luisa'),('maddalena'),('margherita'),('marina'),('mariangela'),('marisa'),('natalina'),('noemi'),('olga'),
  ('ornella'),('pia'),('raffaella'),('rita'),('rossana'),('sabrina'),('serena'),('stefania'),('tiziana'),('vanessa'),
  ('vera'),('veronica'),('vincenza'),('vittoria'),('ada'),('adriana'),('agata'),('agnese'),('alba'),('albina'),
  ('alda'),('alessandra'),('alma'),('amalia'),('amelia'),('angelica'),('annamaria'),('annarita'),('antonia'),('arianna'),
  ('assunta'),('aurora'),('beatrice'),('bianca'),('bruna'),('camilla'),('candida'),('caterina'),('celeste'),('clara'),
  ('clelia'),('cosima'),('costanza'),('debora'),('delia'),('denise'),('diana'),('dina'),('dolores'),('donatella'),
  ('edda'),('eleonora'),('elettra'),('elvira'),('emanuela'),('emilia'),('erica'),('erminia'),('ersilia'),('eugenia'),
  ('eva'),('fabiola'),('fernanda'),('fiorella'),('fiorenza'),('flavia'),('flora'),('franca'),('gaia'),('gemma'),
  ('gianna'),('gilda'),('gina'),('ginevra'),('gioia'),('giordana'),('giovanna'),('giulietta'),('grazia'),('graziella'),
  ('greta'),('ida'),('ines'),('iolanda'),('irene'),('iris'),('irma'),('isabella'),('jessica'),('katia'),
  ('lara'),('larissa'),('letizia'),('lidia'),('liliana'),('linda'),('lisa'),('livia'),('loredana'),('luana'),
  ('lucrezia'),('ludovica'),('luigia'),('manuela'),('mara'),('marcella'),('mariagrazia'),('mariarosaria'),('marilena'),('marinella'),
  ('mariateresa'),('matilde'),('melissa'),('milena'),('mirella'),('miriam'),('moira'),('morena'),('natalia'),('nicoletta'),
  ('norma'),('nunzia'),('ofelia'),('oriana'),('palma'),('pamela'),('pasqualina'),('penelope'),('perla'),('priscilla'),
  ('rachele'),('raffaela'),('ramona'),('rebecca'),('renata'),('rina'),('romina'),('rosalba'),('rosalia'),('rosaria'),
  ('rossella'),('samantha'),('sandra'),('selvaggia'),('sheila'),('silvana'),('sonia'),('stella'),('susanna'),('tamara'),
  ('teodora'),('valeria'),('vania'),('viola'),('virginia'),('wanda'),('ylenia'),('pinco'),('pallino')
on conflict (nome) do nothing;

-- ---------------------------------------------------------------------
-- FUNZIONE CONDIVISA: estrai_iniziale_cognome
-- ---------------------------------------------------------------------
create or replace function estrai_iniziale_cognome(p_nome_completo text)
returns char(1) as $$
declare
  v_tokens text[];
  v_primo text;
  v_ultimo text;
  v_primo_e_nome boolean;
  v_ultimo_e_nome boolean;
  v_cognome text;
begin
  if p_nome_completo is null or trim(p_nome_completo) = '' then
    return null;
  end if;

  -- Tokenizza per spazi/trattini, scarta token vuoti e pure congiunzioni
  -- (es. "e" in "Rodolfo e Maria ..."), cosi' non vengono mai scambiate per
  -- nome o cognome.
  select array_agg(t) into v_tokens
  from unnest(regexp_split_to_array(trim(p_nome_completo), '[\s\-]+')) as t
  where t <> '' and lower(t) not in ('e', '&', 'e/o', 'ed');

  if v_tokens is null or array_length(v_tokens, 1) = 0 then
    return upper(substring(trim(p_nome_completo) from 1 for 1));
  end if;

  v_primo := v_tokens[1];
  v_ultimo := v_tokens[array_length(v_tokens, 1)];

  if array_length(v_tokens, 1) = 1 then
    v_cognome := v_primo;
  else
    select exists(select 1 from nomi_propri_comuni where nome = lower(v_primo)) into v_primo_e_nome;
    select exists(select 1 from nomi_propri_comuni where nome = lower(regexp_replace(v_ultimo, '[^\w'']', '', 'g'))) into v_ultimo_e_nome;

    if v_primo_e_nome and not v_ultimo_e_nome then
      -- "Noemi Gambino": Noemi e' un nome comune, Gambino no -> il cognome e' l'ultima parola.
      v_cognome := v_ultimo;
    else
      -- Comportamento storico invariato: prima parola = cognome (caso piu' comune, "Cognome Nome").
      v_cognome := v_primo;
    end if;
  end if;

  return upper(substring(v_cognome from 1 for 1));
end;
$$ language plpgsql stable;

-- ---------------------------------------------------------------------
-- Le due versioni esistenti di assegna_operatore_automatico ora usano la
-- stessa funzione condivisa invece di calcolare l'iniziale inline: nessuna
-- altra modifica a firma, trigger o logica di regole_assegnazione.
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
  v_iniziale := estrai_iniziale_cognome(p_cliente_nome);

  select ra.operatore_id into v_operatore_id
  from regole_assegnazione ra
  where ra.attiva = true
    and ra.criterio = 'iniziale_cognome'
    and ra.tipo_pratica = p_tipo_pratica
    and (ra.brand_id is null or ra.brand_id = p_brand_id)
    and v_iniziale between upper(ra.valore_da) and upper(ra.valore_a)
  order by (ra.brand_id is not null) desc, ra.priorita asc
  limit 1;

  return v_operatore_id;
end;
$$ language plpgsql stable;

create or replace function assegna_operatore_automatico(p_cliente_nome text)
returns uuid as $$
declare
  v_iniziale char(1);
  v_operatore_id uuid;
begin
  v_iniziale := estrai_iniziale_cognome(p_cliente_nome);

  select ra.operatore_id into v_operatore_id
  from regole_assegnazione ra
  where ra.attiva = true
    and ra.criterio = 'iniziale_cognome'
    and v_iniziale between upper(ra.valore_da) and upper(ra.valore_a)
  order by ra.priorita asc
  limit 1;

  return v_operatore_id;
end;
$$ language plpgsql stable;

-- NOTA: questa migrazione cambia solo COME si calcola l'iniziale per le
-- pratiche NUOVE (o ri-processate esplicitamente, es. un futuro backfill
-- mirato). Non tocca le pratiche gia' assegnate: per correggere casi
-- specifici gia' sbagliati (es. 1002/26, 1011/26) serve un aggiornamento
-- manuale mirato (vedi script separato), non una migrazione di schema.
