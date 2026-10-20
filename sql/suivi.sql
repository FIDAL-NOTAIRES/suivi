-- SUIVI — tables du lot 1 (à exécuter UNE FOIS dans l'éditeur SQL de Neon, projet gentle-firefly-91584148)
-- Le texte des mails n'est jamais conservé ici : seulement la fiche du dossier, ses étapes, notes et rappels.

-- (Le droit sur le schéma public a déjà été donné à matrice_owner le 09/09/2026 ; rien à refaire.)

CREATE TABLE IF NOT EXISTS suivi_dossier (
  id                 serial PRIMARY KEY,
  intitule           text NOT NULL,
  partie1            text NOT NULL,             -- vendeur, ou nom unique (succession, société)
  partie2            text,                      -- acquéreur, facultatif
  numero             text,                      -- numéro de dossier, facultatif
  adresses           text[] NOT NULL DEFAULT '{}',
  etape              text NOT NULL DEFAULT 'en_cours'
                     CHECK (etape IN ('en_cours','avant_contrat','formalites','abandonne')),
  signature_prevue   date,
  signature_le       date,                      -- date validée du passage à « signé »
  classe_le          date,                      -- entrée dans le sous-ensemble « signés » (signature + 30 jours, ou abandon)
  motif_abandon      text,
  collaborateur      text,                      -- adresse du collaborateur référent
  collab_relances    boolean NOT NULL DEFAULT false,
  cree_le            timestamptz NOT NULL DEFAULT now(),
  maj_le             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS suivi_evenement (
  id          serial PRIMARY KEY,
  dossier_id  integer NOT NULL REFERENCES suivi_dossier(id) ON DELETE CASCADE,
  nature      text NOT NULL CHECK (nature IN ('note','etape','rappel','creation')),
  texte       text NOT NULL,
  date_evt    date NOT NULL,
  cree_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_evenement_dossier ON suivi_evenement (dossier_id, date_evt DESC, id DESC);

CREATE TABLE IF NOT EXISTS suivi_rappel (
  id          serial PRIMARY KEY,
  dossier_id  integer NOT NULL REFERENCES suivi_dossier(id) ON DELETE CASCADE,
  texte       text NOT NULL,
  echeance    date NOT NULL,
  fait_le     date,
  cree_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_rappel_ouvert ON suivi_rappel (echeance) WHERE fait_le IS NULL;

-- Droits du rôle applicatif (sans effet si le script est exécuté par matrice_owner lui-même)
GRANT SELECT, INSERT, UPDATE, DELETE ON suivi_dossier, suivi_evenement, suivi_rappel TO "matrice_owner";
GRANT USAGE, SELECT ON SEQUENCE suivi_dossier_id_seq, suivi_evenement_id_seq, suivi_rappel_id_seq TO "matrice_owner";
