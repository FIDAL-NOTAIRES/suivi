-- SUIVI — suivi-6.sql — lot « pont 1 » : reprise des fiches de relevé déposées dans le Drive par les tâches programmées
-- (arbitrages du 21/10/2026, vocal de 19 h 35 puis PC).
-- À exécuter UNE FOIS dans l'éditeur SQL de Neon (projet gentle-firefly-91584148),
-- AVANT d'envoyer la nouvelle version de api/suivi.js. Peut être rejoué sans dommage.

-- 1. Les fiches de relevé déjà reprises (identifiant Drive : une fiche n'est jamais traitée deux fois)
CREATE TABLE IF NOT EXISTS suivi_releve (
  drive_id    text PRIMARY KEY,
  nom         text,
  releve_le   timestamptz,            -- heure d'exécution de la tâche programmée
  periode_du  timestamptz,
  periode_au  timestamptz,
  statut      text NOT NULL,          -- ok | erreur | illisible
  erreur      text,
  nb_mails    integer NOT NULL DEFAULT 0,
  repris_le   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_releve_date ON suivi_releve (releve_le DESC);

-- 2. Les mails relevés (identifiant Outlook : un mail n'est jamais compté deux fois).
--    Jamais le texte du mail : seulement la synthèse déposée par la tâche.
CREATE TABLE IF NOT EXISTS suivi_mail (
  id_outlook          text PRIMARY KEY,
  releve              text REFERENCES suivi_releve(drive_id) ON DELETE SET NULL,
  dossier_id          integer REFERENCES suivi_dossier(id) ON DELETE SET NULL,
  etat                text NOT NULL CHECK (etat IN ('rattache','a_rattacher','ignore')),
  motif_etat          text,                  -- pourquoi rattaché / pourquoi à rattacher
  sens                text,                  -- reçu | envoyé
  date_mail           timestamptz,
  expediteur          text,
  destinataires       text[] NOT NULL DEFAULT '{}',
  copies              text[] NOT NULL DEFAULT '{}',
  etude               text[] NOT NULL DEFAULT '{}',
  objet               text,
  resume              text,
  dossier_pressenti   text,
  motif_rattachement  text,
  certitude           text,
  reponse_attendue    boolean NOT NULL DEFAULT false,
  reponse_de          text,
  changements         jsonb,
  pieces_jointes      text[] NOT NULL DEFAULT '{}',
  acte_signe_annonce  boolean NOT NULL DEFAULT false,
  signature_proche    boolean NOT NULL DEFAULT false,
  cree_le             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_mail_etat ON suivi_mail (etat, date_mail DESC);
CREATE INDEX IF NOT EXISTS suivi_mail_dossier ON suivi_mail (dossier_id, date_mail DESC);

-- 3. Expéditeurs ignorés : au 2e mail ignoré, les suivants sont écartés d'office
CREATE TABLE IF NOT EXISTS suivi_expediteur_ignore (
  adresse  text PRIMARY KEY,
  fois     integer NOT NULL DEFAULT 1,
  maj_le   timestamptz NOT NULL DEFAULT now()
);

-- 4. La chronologie accepte les lignes « mail », reliées au mail relevé
ALTER TABLE suivi_evenement ADD COLUMN IF NOT EXISTS mail_id text;
ALTER TABLE suivi_evenement DROP CONSTRAINT IF EXISTS suivi_evenement_nature_check;
ALTER TABLE suivi_evenement ADD CONSTRAINT suivi_evenement_nature_check
  CHECK (nature IN ('note','etape','rappel','creation','echeance','delai','mail'));

-- 5. Droits du rôle applicatif
GRANT SELECT, INSERT, UPDATE, DELETE ON suivi_releve, suivi_mail, suivi_expediteur_ignore TO "matrice_owner";
