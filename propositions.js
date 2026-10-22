/* SUIVI — module de création : fiches de dossier proposées à partir du balayage (arbitrage du 22/10/2026).
   Claude consolide les feuilles du balayage (Envoyés, Reçus, sous-dossiers) et dépose dans le dossier Drive
   « SUIVI – relevés » des fichiers « propositions-NN.json ». La page de SUIVI les lit par le relais Drive et
   les envoie ici. JFD valide ensuite chaque fiche une par une : Valider, Modifier, Fusionner, Écarter.
   Règles :
   - un fichier n'est jamais repris deux fois (identifiant Drive) ; une fiche est repérée par son intitulé normalisé ;
   - une fiche déjà tranchée par JFD (validée, fusionnée, écartée) n'est JAMAIS reproposée ; une fiche encore
     proposée est complétée par les lots suivants (adresses, tranches, dates) ;
   - « Valider » vaut rattachement à la main : les adresses de la fiche sont apprises par le dossier créé ;
   - « Fusionner » verse les adresses de la fiche dans un dossier existant (même règle). */
'use strict';
const types = require('./types.js');
const MAX = 400;

function txt(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max || 300) : null;
}
function jour(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null; }
function adresses(v) {
  const l = (Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/)).map(x => {
    const m = String(x || '').trim().toLowerCase().match(/[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/);
    return m ? m[0] : null;
  }).filter(Boolean);
  return [...new Set(l)].slice(0, 60);
}
function cle(intitule) {
  return String(intitule || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
function propositionDeFichier(p) {
  if (!p || typeof p !== 'object') return null;
  const intitule = txt(p.intitule, 200);
  if (!intitule) return null;
  const tout = adresses(p.adresses).concat(adresses(p.etude));
  const t = types.TYPES.some(x => x.id === p.type_dossier) ? p.type_dossier : null;
  return {
    cle: cle(intitule), intitule: intitule.toUpperCase(),
    partie1: txt(p.partie1, 120), partie2: txt(p.partie2, 120), numero: txt(p.numero, 40),
    type_dossier: t, date_ouverture: jour(p.date_ouverture), dernier_mail: jour(p.dernier_mail),
    date_deces: t === 'fam_succession' ? jour(p.date_deces) : null, signature_prevue: jour(p.signature_prevue),
    adresses: tout.filter(a => !types.estEtude(a)), etude: tout.filter(a => types.estEtude(a)),
    sources: (Array.isArray(p.sources) ? p.sources : [p.sources]).map(x => txt(x, 40)).filter(Boolean).slice(0, 40),
    resume: txt(p.resume, 600), a_verifier: txt(p.a_verifier, 600), urgent: !!p.urgent
  };
}

// Reprise des fichiers : [{ drive_id, nom, contenu }]
async function importer(sql, fichiers) {
  const bilan = { fichiers: 0, deja: 0, nouvelles: 0, completees: 0, tranchees: 0, illisibles: 0 };
  for (const f of (Array.isArray(fichiers) ? fichiers : []).slice(0, 10)) {
    const driveId = txt(f && f.drive_id, 200);
    if (!driveId) continue;
    const c = f.contenu && typeof f.contenu === 'object' ? f.contenu : null;
    const liste = c && Array.isArray(c.propositions) ? c.propositions.slice(0, MAX).map(propositionDeFichier).filter(Boolean) : [];
    const ins = await sql`INSERT INTO suivi_proposition_lot (drive_id, nom, nb) VALUES (${driveId}, ${txt(f.nom, 200)}, ${liste.length})
      ON CONFLICT (drive_id) DO NOTHING RETURNING drive_id`;
    if (!ins.length) { bilan.deja++; continue; }
    bilan.fichiers++;
    if (!c) { bilan.illisibles++; continue; }
    for (const p of liste) {
      const [ex] = await sql`SELECT cle, etat FROM suivi_proposition WHERE cle = ${p.cle}`;
      if (!ex) {
        await sql`INSERT INTO suivi_proposition (cle, lot, intitule, partie1, partie2, numero, type_dossier, date_ouverture, dernier_mail,
            date_deces, signature_prevue, adresses, etude, sources, resume, a_verifier, urgent)
          VALUES (${p.cle}, ${driveId}, ${p.intitule}, ${p.partie1}, ${p.partie2}, ${p.numero}, ${p.type_dossier}, ${p.date_ouverture}, ${p.dernier_mail},
            ${p.date_deces}, ${p.signature_prevue}, ${p.adresses}, ${p.etude}, ${p.sources}, ${p.resume}, ${p.a_verifier}, ${p.urgent})`;
        bilan.nouvelles++;
      } else if (ex.etat !== 'propose') {
        bilan.tranchees++;   /* JFD a déjà tranché : on ne repropose pas */
      } else {
        await sql`UPDATE suivi_proposition SET
            adresses = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(adresses || ${p.adresses}::text[]) AS x),
            etude = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(etude || ${p.etude}::text[]) AS x),
            sources = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(sources || ${p.sources}::text[]) AS x),
            date_ouverture = LEAST(date_ouverture, ${p.date_ouverture}::date),
            dernier_mail = GREATEST(dernier_mail, ${p.dernier_mail}::date),
            partie1 = coalesce(partie1, ${p.partie1}), partie2 = coalesce(partie2, ${p.partie2}), numero = coalesce(numero, ${p.numero}),
            type_dossier = coalesce(type_dossier, ${p.type_dossier}), date_deces = coalesce(date_deces, ${p.date_deces}),
            signature_prevue = coalesce(${p.signature_prevue}::date, signature_prevue),
            resume = coalesce(${p.resume}, resume),
            a_verifier = CASE WHEN ${p.a_verifier}::text IS NULL THEN a_verifier WHEN a_verifier IS NULL THEN ${p.a_verifier}::text ELSE a_verifier || ' ; ' || ${p.a_verifier}::text END,
            urgent = urgent OR ${p.urgent}
          WHERE cle = ${p.cle}`;
        bilan.completees++;
      }
    }
  }
  return bilan;
}

function versChaines(r) {
  const x = { ...r };
  for (const k of ['date_ouverture', 'dernier_mail', 'date_deces', 'signature_prevue']) if (x[k] instanceof Date) x[k] = x[k].toISOString().slice(0, 10);
  for (const k of ['decide_le', 'cree_le']) if (x[k] instanceof Date) x[k] = x[k].toISOString();
  return x;
}
async function lister(sql) {
  return (await sql`SELECT * FROM suivi_proposition WHERE etat = 'propose' ORDER BY dernier_mail DESC NULLS LAST, intitule LIMIT 1000`).map(versChaines);
}
async function compter(sql) {
  const [n] = await sql`SELECT count(*)::int AS n FROM suivi_proposition WHERE etat = 'propose'`;
  return n.n;
}
async function marquer(sql, c, etat, dossierId) {
  const r = await sql`UPDATE suivi_proposition SET etat = ${etat}, dossier_id = ${dossierId || null}, decide_le = now()
    WHERE cle = ${txt(c, 200)} AND etat = 'propose' RETURNING *`;
  return r[0] || null;
}
// Fusion dans un dossier existant : adresses et collaborateurs versés (rattachement à la main)
async function fusionner(sql, c, dossierId) {
  const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${dossierId}`;
  if (!d) return { erreur: 'Dossier introuvable.' };
  const p = await marquer(sql, c, 'fusionne', dossierId);
  if (!p) return { erreur: 'Fiche introuvable ou déjà tranchée.' };
  await sql`UPDATE suivi_dossier SET
      adresses = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(adresses || ${p.adresses}::text[]) AS x),
      etude = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(etude || ${p.etude}::text[]) AS x),
      maj_le = now() WHERE id = ${dossierId}`;
  return { ok: true, proposition: versChaines(p) };
}

module.exports = { cle, propositionDeFichier, importer, lister, compter, marquer, fusionner };
