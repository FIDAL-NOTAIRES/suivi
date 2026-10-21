-- SUIVI — bloc « Étude » (arbitrages du 21/10/2026) : les adresses de l'étude sont rangées à part,
-- avec les collaborateurs destinataires des relances ; liste des collaborateurs du cabinet en base
-- (jamais dans le dépôt GitHub, qui est public).
-- À exécuter UNE FOIS dans l'éditeur SQL de Neon (projet gentle-firefly-91584148),
-- AVANT d'envoyer la nouvelle version de api/suivi.js. Peut être rejoué sans dommage.

-- 1. Liste des collaborateurs du cabinet, alimentée par l'import du fichier Excel
CREATE TABLE IF NOT EXISTS suivi_collaborateur (
  adresse    text PRIMARY KEY,
  nom        text NOT NULL,
  prenom     text,
  site       text,
  importe_le timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON suivi_collaborateur TO "matrice_owner";

-- 2. Bloc « Étude » de chaque dossier : adresses de l'étude, et celles qui reçoivent les relances
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS etude          text[] NOT NULL DEFAULT '{}';
ALTER TABLE suivi_dossier ADD COLUMN IF NOT EXISTS etude_relances text[] NOT NULL DEFAULT '{}';

-- 3. Reprise de l'ancien « collaborateur référent »
UPDATE suivi_dossier SET etude = ARRAY[collaborateur]
  WHERE collaborateur IS NOT NULL AND etude = '{}';
UPDATE suivi_dossier SET etude_relances = ARRAY[collaborateur]
  WHERE collaborateur IS NOT NULL AND collab_relances AND etude_relances = '{}';

-- 4. Correction de l'erreur constatée : les adresses @fidal.notaires.fr rangées parmi les
--    correspondants passent dans le bloc « Étude » (sauf celle de JFD)
UPDATE suivi_dossier SET
  etude = ARRAY(SELECT DISTINCT x FROM unnest(etude || adresses) AS x
                WHERE x LIKE '%@fidal.notaires.fr' AND x <> 'jean-francois.dumetz@fidal.notaires.fr'),
  adresses = ARRAY(SELECT x FROM unnest(adresses) AS x WHERE x NOT LIKE '%@fidal.notaires.fr')
  WHERE EXISTS (SELECT 1 FROM unnest(adresses) AS x WHERE x LIKE '%@fidal.notaires.fr');
