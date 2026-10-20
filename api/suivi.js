// SUIVI — fonction serveur unique (lot 1 : sans messagerie).
// GET  /api/suivi?action=etat|liste|dossier&id=…
// POST /api/suivi  { action: creer|modifier|etape|note|rappel|rappel_fait|rappel_reporter|echeance|echeance_faite|echeance_retirer|deposer|supprimer, … }
// Accès : en-tête x-suivi-code comparé à la variable SUIVI_CODE_ADMIN (JFD seul).
'use strict';
const crypto = require('crypto');
const cal = require('../calendrier.js');
const types = require('../types.js');

let sqlInjecte = null; // pour les essais
function db() {
  if (sqlInjecte) return sqlInjecte;
  const { neon } = require('@neondatabase/serverless');
  return neon(process.env.DATABASE_URL);
}

const ETAPES = ['en_cours', 'avant_contrat', 'signe', 'abandonne'];
const MOTIFS_ABANDON = ['Rétractation', 'Condition suspensive non réalisée', 'Refus de prêt', 'Vente à un tiers'];
const GRACE_JOURS = 30;
const LIBELLES_ECHEANCE = ['Levée des conditions suspensives', 'Obtention du prêt', 'Date butoir de réitération'];

function codeValide(recu) {
  const attendu = process.env.SUIVI_CODE_ADMIN || '';
  if (!attendu || typeof recu !== 'string') return false;
  const a = crypto.createHash('sha256').update(recu).digest();
  const b = crypto.createHash('sha256').update(attendu).digest();
  return crypto.timingSafeEqual(a, b);
}
function texte(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max || 300) : null;
}
function date(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null; }
function adresses(v) {
  const liste = Array.isArray(v) ? v : String(v || '').split(/[\s,;]+/);
  const ok = liste.map(x => String(x).trim().toLowerCase()).filter(x => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x));
  return [...new Set(ok)].slice(0, 50);
}
function nomOutlook(d) {
  const p1 = (d.partie1 || '').toUpperCase(), p2 = (d.partie2 || '').toUpperCase();
  return [d.numero, p2 ? p1 + ' / ' + p2 : p1].filter(Boolean).join(' ');
}
function erreur(res, code, message) { res.status(code).json({ erreur: message }); }
const libelle = { en_cours: 'En cours', avant_contrat: 'Avant-contrat', signe: 'Signé', abandonne: 'Abandonné' };
const fr = s => s.split('-').reverse().join('/');

// Un mail déposé : on n'en garde que l'objet, l'expéditeur et la date (jamais le texte)
function ligneMail(m) {
  const objet = texte(m && m.objet, 300) || '(sans objet)';
  const de = texte(m && m.expediteur, 200);
  const d = date(m && m.date);
  return { texte: 'Mail déposé' + (de ? ' — de ' + de : '') + (d ? ', du ' + fr(d) : '') + ' : « ' + objet + ' »', jour: d };
}

async function evenement(sql, id, nature, txt, jour) {
  await sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt) VALUES (${id}, ${nature}, ${txt}, ${jour})`;
}

async function liste(sql, jour) {
  // Retrait des fiches classées depuis plus de deux ans (les mails restent dans Outlook)
  const limite = (+jour.slice(0, 4) - 2) + jour.slice(4);
  await sql`DELETE FROM suivi_dossier WHERE classe_le IS NOT NULL AND classe_le <= ${limite}`;
  const dossiers = await sql`
    SELECT d.*,
      (SELECT count(*)::int FROM suivi_rappel r WHERE r.dossier_id = d.id AND r.fait_le IS NULL) AS rappels_ouverts,
      (SELECT count(*)::int FROM suivi_rappel r WHERE r.dossier_id = d.id AND r.fait_le IS NULL AND r.echeance <= ${jour}) AS rappels_echus,
      (SELECT max(e.date_evt) FROM suivi_evenement e WHERE e.dossier_id = d.id AND e.nature <> 'creation') AS dernier_evt,
      (SELECT min(x.echeance) FROM suivi_echeance x WHERE x.dossier_id = d.id AND x.faite_le IS NULL) AS prochaine_echeance
    FROM suivi_dossier d ORDER BY d.signature_prevue NULLS FIRST, d.id`;
  const rappels = await sql`
    SELECT r.id, r.dossier_id, r.texte, r.echeance, d.intitule
    FROM suivi_rappel r JOIN suivi_dossier d ON d.id = r.dossier_id
    WHERE r.fait_le IS NULL AND r.echeance <= ${jour} ORDER BY r.echeance, r.id`;
  // échéances de l'acte à moins de 15 jours, ou dépassées
  const horizon = cal.decaler(jour, 15);
  const echeances = await sql`
    SELECT x.id, x.dossier_id, x.libelle, x.echeance, d.intitule
    FROM suivi_echeance x JOIN suivi_dossier d ON d.id = x.dossier_id
    WHERE x.faite_le IS NULL AND x.echeance <= ${horizon} AND d.etape <> 'abandonne' AND d.signature_le IS NULL
    ORDER BY x.echeance, x.id`;
  return { dossiers: dossiers.map(d => ({ ...versChaines(d), nom_outlook: nomOutlook(d) })), rappels_echus: rappels.map(versChaines), echeances_proches: echeances.map(versChaines) };
}

// Les dates renvoyées par la base deviennent des chaînes AAAA-MM-JJ
function versChaines(o) {
  const x = { ...o };
  for (const k of ['signature_prevue', 'signature_le', 'classe_le', 'echeance', 'fait_le', 'faite_le', 'date_evt', 'dernier_evt',
    'date_ouverture', 'date_deces', 'prochaine_echeance']) {
    if (x[k] instanceof Date) x[k] = x[k].toISOString().slice(0, 10);
  }
  return x;
}

async function traiter(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!process.env.SUIVI_CODE_ADMIN) return erreur(res, 503, 'Accès non configuré (variable SUIVI_CODE_ADMIN absente).');
  if (!codeValide(req.headers['x-suivi-code'])) {
    await new Promise(r => setTimeout(r, sqlInjecte ? 0 : 400));
    return erreur(res, 401, 'Code incorrect.');
  }
  const sql = db();
  const jour = cal.aujourdhui();
  const q = req.query || {};
  const b = (req.method === 'POST' ? (typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body) : null) || {};
  const action = req.method === 'GET' ? q.action : b.action;

  if (req.method === 'GET' && action === 'etat') {
    return res.json({ aujourdhui: jour, jour: cal.infoJour(jour), couleur_du_temps: cal.couleurDuTemps(jour), motifs_abandon: MOTIFS_ABANDON, libelles_echeance: LIBELLES_ECHEANCE });
  }
  if (req.method === 'GET' && action === 'liste') return res.json({ aujourdhui: jour, ...(await liste(sql, jour)) });
  if (req.method === 'GET' && action === 'dossier') {
    const id = +q.id;
    const [d] = await sql`SELECT * FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    const evenements = await sql`SELECT * FROM suivi_evenement WHERE dossier_id = ${id} ORDER BY date_evt DESC, id DESC`;
    const rappels = await sql`SELECT * FROM suivi_rappel WHERE dossier_id = ${id} ORDER BY fait_le NULLS FIRST, echeance, id`;
    const echeances = await sql`SELECT * FROM suivi_echeance WHERE dossier_id = ${id} ORDER BY faite_le NULLS FIRST, echeance, id`;
    return res.json({ dossier: { ...versChaines(d), nom_outlook: nomOutlook(d) }, evenements: evenements.map(versChaines), rappels: rappels.map(versChaines), echeances: echeances.map(versChaines) });
  }
  if (req.method !== 'POST') return erreur(res, 405, 'Action inconnue.');

  if (action === 'creer' || action === 'modifier') {
    const champs = {
      intitule: texte(b.intitule, 200), partie1: texte(b.partie1, 120), partie2: texte(b.partie2, 120),
      numero: texte(b.numero, 40), adresses: adresses(b.adresses), signature_prevue: date(b.signature_prevue),
      collaborateur: (adresses([b.collaborateur])[0]) || null, collab_relances: !!b.collab_relances,
      type_dossier: types.TYPES.some(t => t.id === b.type_dossier) ? b.type_dossier : null,
      date_ouverture: date(b.date_ouverture) || jour, date_deces: date(b.date_deces), delai_jours: null
    };
    if (!champs.intitule || !champs.partie1) return erreur(res, 400, 'L’intitulé et le nom de la première partie sont obligatoires.');
    if (!champs.type_dossier) return erreur(res, 400, 'Choisissez le type de dossier.');
    const t = types.type(champs.type_dossier);
    if (t.depuis !== 'deces') champs.date_deces = null;
    if (t.ajustable) {
      const n = Math.round(+b.delai_jours);
      if (n >= 1 && n <= 1500 && n !== t.delai) champs.delai_jours = n;
    }
    if (champs.collab_relances && !champs.collaborateur) champs.collab_relances = false;
    if (action === 'creer') {
      const etape = b.etape === 'avant_contrat' ? 'avant_contrat' : 'en_cours';
      const [d] = await sql`INSERT INTO suivi_dossier (intitule, partie1, partie2, numero, adresses, etape, signature_prevue, collaborateur, collab_relances,
          type_dossier, date_ouverture, date_deces, delai_jours)
        VALUES (${champs.intitule}, ${champs.partie1}, ${champs.partie2}, ${champs.numero}, ${champs.adresses}, ${etape}, ${champs.signature_prevue}, ${champs.collaborateur}, ${champs.collab_relances},
          ${champs.type_dossier}, ${champs.date_ouverture}, ${champs.date_deces}, ${champs.delai_jours})
        RETURNING *`;
      await evenement(sql, d.id, 'creation', 'Dossier créé — ' + t.nom + ', ouvert le ' + fr(champs.date_ouverture) + ' (dossier Outlook : « ' + nomOutlook(d) + ' »)', champs.date_ouverture);
      if (b.mail) { const l = ligneMail(b.mail); await evenement(sql, d.id, 'note', l.texte, l.jour || jour); }
      return res.json({ dossier: { ...versChaines(d), nom_outlook: nomOutlook(d) } });
    }
    const id = +b.id;
    const [d] = await sql`UPDATE suivi_dossier SET intitule = ${champs.intitule}, partie1 = ${champs.partie1}, partie2 = ${champs.partie2},
        numero = ${champs.numero}, adresses = ${champs.adresses}, signature_prevue = ${champs.signature_prevue},
        collaborateur = ${champs.collaborateur}, collab_relances = ${champs.collab_relances},
        type_dossier = ${champs.type_dossier}, date_ouverture = ${champs.date_ouverture}, date_deces = ${champs.date_deces}, delai_jours = ${champs.delai_jours}, maj_le = now()
      WHERE id = ${id} RETURNING *`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    return res.json({ dossier: { ...versChaines(d), nom_outlook: nomOutlook(d) } });
  }

  if (action === 'etape') {
    const id = +b.id, cible = b.etape, le = date(b.date);
    if (!ETAPES.includes(cible)) return erreur(res, 400, 'Étape inconnue.');
    if (!le) return erreur(res, 400, 'La date du changement d’étape est obligatoire.');
    const [d] = await sql`SELECT * FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    if (d.etape === 'abandonne') return erreur(res, 409, 'Un dossier abandonné ne se réactive pas : créez un nouveau dossier.');
    let maj;
    if (cible === 'signe') {
      const classe = cal.decaler(le, GRACE_JOURS);
      [maj] = await sql`UPDATE suivi_dossier SET etape = 'formalites', signature_le = ${le}, classe_le = ${classe}, maj_le = now() WHERE id = ${id} RETURNING *`;
      await evenement(sql, id, 'etape', 'Acte signé le ' + fr(le) + ' — formalités ; classement dans « signés » le ' + fr(classe), le);
    } else if (cible === 'abandonne') {
      const motif = texte(b.motif, 200);
      if (!motif) return erreur(res, 400, 'Le motif d’abandon est obligatoire.');
      [maj] = await sql`UPDATE suivi_dossier SET etape = 'abandonne', motif_abandon = ${motif}, classe_le = ${le}, maj_le = now() WHERE id = ${id} RETURNING *`;
      await evenement(sql, id, 'etape', 'Dossier abandonné le ' + fr(le) + ' — motif : ' + motif, le);
    } else {
      [maj] = await sql`UPDATE suivi_dossier SET etape = ${cible}, signature_le = NULL, classe_le = NULL, maj_le = now() WHERE id = ${id} RETURNING *`;
      await evenement(sql, id, 'etape', 'Étape « ' + libelle[cible] + ' » le ' + fr(le), le);
    }
    return res.json({ dossier: { ...versChaines(maj), nom_outlook: nomOutlook(maj) } });
  }

  if (action === 'note') {
    const id = +b.id, txt = texte(b.texte, 2000), le = date(b.date) || jour;
    if (!txt) return erreur(res, 400, 'La note est vide.');
    const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    await evenement(sql, id, 'note', txt, le);
    return res.json({ ok: true });
  }

  if (action === 'deposer') {
    const id = +b.id;
    const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    const l = ligneMail(b.mail || {});
    await evenement(sql, id, 'note', l.texte, l.jour || jour);
    // SUIVI apprend les adresses du mail rattaché à la main
    const nouvelles = adresses(b.adresses);
    if (nouvelles.length) await sql`UPDATE suivi_dossier SET adresses = (SELECT array_agg(DISTINCT x) FROM unnest(adresses || ${nouvelles}::text[]) AS x), maj_le = now() WHERE id = ${id}`;
    let rappel = null;
    const txt = texte(b.rappel, 500), delai = +b.delai;
    if (txt && (delai === 3 || delai === 7)) {
      const echeance = cal.ajouterJoursOuvres(jour, delai);
      [rappel] = await sql`INSERT INTO suivi_rappel (dossier_id, texte, echeance) VALUES (${id}, ${txt}, ${echeance}) RETURNING *`;
      await evenement(sql, id, 'rappel', 'Rappel posé pour le ' + fr(echeance) + ' : ' + txt, jour);
    }
    return res.json({ ok: true, rappel: rappel ? versChaines(rappel) : null });
  }

  if (action === 'rappel') {
    const id = +b.id, txt = texte(b.texte, 500), delai = +b.delai;
    if (!txt) return erreur(res, 400, 'Le rappel est vide.');
    if (delai !== 3 && delai !== 7) return erreur(res, 400, 'Échéance : 3 ou 7 jours ouvrés.');
    const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    const echeance = cal.ajouterJoursOuvres(jour, delai);
    const [r] = await sql`INSERT INTO suivi_rappel (dossier_id, texte, echeance) VALUES (${id}, ${txt}, ${echeance}) RETURNING *`;
    await evenement(sql, id, 'rappel', 'Rappel posé pour le ' + fr(echeance) + ' : ' + txt, jour);
    return res.json({ rappel: versChaines(r) });
  }

  if (action === 'rappel_fait' || action === 'rappel_reporter') {
    const rid = +b.rappel_id;
    const [r] = await sql`SELECT * FROM suivi_rappel WHERE id = ${rid} AND fait_le IS NULL`;
    if (!r) return erreur(res, 404, 'Rappel introuvable ou déjà fait.');
    if (action === 'rappel_fait') {
      await sql`UPDATE suivi_rappel SET fait_le = ${jour} WHERE id = ${rid}`;
      await evenement(sql, r.dossier_id, 'rappel', 'Rappel fait : ' + r.texte, jour);
      return res.json({ ok: true });
    }
    const echeance = cal.ajouterJoursOuvres(jour, 3);
    await sql`UPDATE suivi_rappel SET echeance = ${echeance} WHERE id = ${rid}`;
    await evenement(sql, r.dossier_id, 'rappel', 'Rappel reporté au ' + fr(echeance) + ' : ' + r.texte, jour);
    return res.json({ echeance });
  }

  if (action === 'echeance') {
    const id = +b.id, lib = texte(b.libelle, 200), le = date(b.date);
    if (!lib) return erreur(res, 400, 'Indiquez l’objet de l’échéance.');
    if (!le) return erreur(res, 400, 'La date de l’échéance est obligatoire.');
    const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    const [x] = await sql`INSERT INTO suivi_echeance (dossier_id, libelle, echeance) VALUES (${id}, ${lib}, ${le}) RETURNING *`;
    await evenement(sql, id, 'echeance', 'Échéance inscrite pour le ' + fr(le) + ' : ' + lib, jour);
    return res.json({ echeance: versChaines(x) });
  }

  if (action === 'echeance_faite' || action === 'echeance_retirer') {
    const xid = +b.echeance_id;
    const [x] = await sql`SELECT * FROM suivi_echeance WHERE id = ${xid}`;
    if (!x) return erreur(res, 404, 'Échéance introuvable.');
    if (action === 'echeance_faite') {
      if (x.faite_le) return erreur(res, 409, 'Échéance déjà marquée comme acquise.');
      const le = date(b.date) || jour;
      await sql`UPDATE suivi_echeance SET faite_le = ${le} WHERE id = ${xid}`;
      await evenement(sql, x.dossier_id, 'echeance', 'Échéance acquise le ' + fr(le) + ' : ' + x.libelle, le);
    } else {
      await sql`DELETE FROM suivi_echeance WHERE id = ${xid}`;
      await evenement(sql, x.dossier_id, 'echeance', 'Échéance retirée : ' + x.libelle + ' (prévue le ' + fr(versChaines(x).echeance) + ')', jour);
    }
    return res.json({ ok: true });
  }

  if (action === 'supprimer') {
    const id = +b.id;
    const r = await sql`DELETE FROM suivi_dossier WHERE id = ${id} RETURNING id`;
    if (!r.length) return erreur(res, 404, 'Dossier introuvable.');
    return res.json({ ok: true });
  }

  return erreur(res, 400, 'Action inconnue.');
}

module.exports = async function handler(req, res) {
  try { await traiter(req, res); }
  catch (e) {
    console.error('SUIVI', e);
    erreur(res, 500, 'La base de données ne répond pas. Réessayez dans un instant.');
  }
};
module.exports._injecter = s => { sqlInjecte = s; };
module.exports._nomOutlook = nomOutlook;
