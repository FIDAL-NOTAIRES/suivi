-- SUIVI — suivi-8.sql — écran des arbitrages du balayage (arbitrages du 26/10/2026, PC, soir).
-- À exécuter UNE FOIS dans l'éditeur SQL de Neon (projet gentle-firefly-91584148),
-- AVANT d'envoyer les nouveaux fichiers. Peut être rejoué sans dommage.

-- 1. Les fichiers « arbitrages-NN.json » déjà repris (identifiant Drive : un fichier n'est jamais repris deux fois)
CREATE TABLE IF NOT EXISTS suivi_arbitrage_lot (
  drive_id  text PRIMARY KEY,
  nom       text,
  nb        integer NOT NULL DEFAULT 0,
  repris_le timestamptz NOT NULL DEFAULT now()
);

-- 2. Les arbitrages : une question par ligne, posée par les intitulés des dossiers
CREATE TABLE IF NOT EXISTS suivi_arbitrage (
  id               text PRIMARY KEY,                -- identifiant donné par Claude (A-0001…)
  lot              text REFERENCES suivi_arbitrage_lot(drive_id) ON DELETE SET NULL,
  nature           text NOT NULL CHECK (nature IN ('meme_dossier','question','a_appliquer')),
  question         text NOT NULL,
  contexte         text,
  dossiers         text[] NOT NULL DEFAULT '{}',    -- intitulés concernés
  reponses         text[] NOT NULL DEFAULT '{}',    -- réponses toutes prêtes (nature « question »)
  operation        text CHECK (operation IN ('fusion','renommage')),   -- nature « a_appliquer »
  intitule_final   text,
  decide_le        date,                            -- date de la décision orale (nature « a_appliquer »)
  etat             text NOT NULL DEFAULT 'ouvert' CHECK (etat IN ('ouvert','a_revoir','repondu','applique')),
  reponse          text,                            -- meme | distincts | réponse toute prête | autre
  reponse_libre    text,
  commentaire      text,
  repondu_le       timestamptz,
  applique_le      timestamptz,
  applique_detail  text,
  cree_le          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_arbitrage_etat ON suivi_arbitrage (etat, cree_le);

-- 3. Droits du rôle applicatif
GRANT SELECT, INSERT, UPDATE, DELETE ON suivi_arbitrage_lot, suivi_arbitrage TO "matrice_owner";
