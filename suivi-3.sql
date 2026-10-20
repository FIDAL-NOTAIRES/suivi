-- SUIVI — anneau par type de dossier (arbitrages du 20/10/2026, soir)
-- À exécuter dans l'éditeur SQL de Neon (projet gentle-firefly-91584148).
-- Le script peut être exécuté plusieurs fois sans dommage.

-- 1. Nouveaux champs de la fiche
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS type_dossier   text NOT NULL DEFAULT 'imm_autre';
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS date_ouverture date;
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS date_deces     date;
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS delai_jours    integer;

UPDATE suivi_dossier SET date_ouverture = cree_le::date WHERE date_ouverture IS NULL;
ALTER TABLE suivi_dossier ALTER COLUMN date_ouverture SET DEFAULT CURRENT_DATE;
ALTER TABLE suivi_dossier ALTER COLUMN date_ouverture SET NOT NULL;

-- Si une colonne « matière » avait été créée par l'ancien script, on en tire le type « autre » de la matière
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'suivi_dossier' AND column_name = 'matiere') THEN
    UPDATE suivi_dossier SET type_dossier = CASE
      WHEN lower(matiere) LIKE 'fam%' THEN 'fam_autre'
      WHEN lower(matiere) LIKE 'aff%' THEN 'aff_autre'
      WHEN lower(matiere) LIKE 'int%' THEN 'int_autre'
      ELSE 'imm_autre' END
    WHERE type_dossier = 'imm_autre';
  END IF;
END $$;

-- 2. Échéances datées tirées de l'acte (conditions suspensives, prêt, réitération…)
CREATE TABLE IF NOT EXISTS suivi_echeance (
  id          serial PRIMARY KEY,
  dossier_id  integer NOT NULL REFERENCES suivi_dossier(id) ON DELETE CASCADE,
  libelle     text NOT NULL,
  echeance    date NOT NULL,
  faite_le    date,
  cree_le     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS suivi_echeance_ouverte ON suivi_echeance (echeance) WHERE faite_le IS NULL;

-- 3. La chronologie accepte désormais les lignes « échéance »
ALTER TABLE suivi_evenement DROP CONSTRAINT IF EXISTS suivi_evenement_nature_check;
ALTER TABLE suivi_evenement ADD CONSTRAINT suivi_evenement_nature_check
  CHECK (nature IN ('note','etape','rappel','creation','echeance'));

-- 4. Droits du rôle applicatif
GRANT SELECT, INSERT, UPDATE, DELETE ON suivi_echeance TO "matrice_owner";
GRANT USAGE, SELECT ON SEQUENCE suivi_echeance_id_seq TO "matrice_owner";
