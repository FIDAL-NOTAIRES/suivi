-- SUIVI — clôture manuelle et date limite réajustable (arbitrages du 21/10/2026, 10 h 24)
-- À exécuter UNE FOIS dans l'éditeur SQL de Neon (projet gentle-firefly-91584148),
-- AVANT d'envoyer la nouvelle version de api/suivi.js. Peut être rejoué sans dommage.

-- 1. Motif de clôture et date limite propre au dossier (après un report)
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS motif_cloture text;
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS date_limite   date;

-- 2. Nouvelle étape « clos »
ALTER TABLE suivi_dossier DROP CONSTRAINT IF EXISTS suivi_dossier_etape_check;
ALTER TABLE suivi_dossier ADD CONSTRAINT suivi_dossier_etape_check
  CHECK (etape IN ('en_cours','avant_contrat','formalites','abandonne','clos'));

-- 3. La chronologie accepte les lignes « délai » (reports de la date limite)
ALTER TABLE suivi_evenement DROP CONSTRAINT IF EXISTS suivi_evenement_nature_check;
ALTER TABLE suivi_evenement ADD CONSTRAINT suivi_evenement_nature_check
  CHECK (nature IN ('note','etape','rappel','creation','echeance','delai'));
