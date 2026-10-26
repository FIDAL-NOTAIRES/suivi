// SUIVI — fonction serveur unique (lot 1, bloc « Étude », lot « pont 1 » : reprise des relevés de mails déposés dans le Drive).
// GET  /api/suivi?action=etat|liste|dossier&id=…|collaborateurs|releves_repris|a_rattacher|propositions|propositions_reprises|arbitrages|arbitrages_repris
// POST /api/suivi  { action: creer|modifier|etape|delai_reporter|importer_collaborateurs|note|rappel|rappel_fait|rappel_reporter|echeance|echeance_faite|echeance_retirer|deposer|supprimer|releves|mail_rattacher|mail_ignorer|propositions|proposition_ecarter|proposition_fusionner|arbitrages|arbitrage_repondre|arbitrage_appliquer, … }
// Accès : en-tête x-suivi-code comparé à la variable SUIVI_CODE_ADMIN (JFD seul).
// Lecture des réponses aux arbitrages par Claude : GET ?action=arbitrages_claude&lecture=… (ou en-tête x-suivi-lecture),
// comparé à la variable SUIVI_CODE_LECTURE ; lecture seule, rien d'autre n'est accessible avec cette clé.
'use strict';
const crypto = require('crypto');
const cal = require('../calendrier.js');
const types = require('../types.js');
const pont = require('../releves.js');
const props = require('../propositions.js');
const arb = require('../arbitrages.js');

let sqlInjecte = null; // pour les essais
function db() {
  if (sqlInjecte) return sqlInjecte;
  const { neon } = require('@neondatabase/serverless');
  return neon(process.env.DATABASE_URL);
}

const ETAPES = ['en_cours', 'avant_contrat', 'signe', 'abandonne', 'clos'];
const MOTIFS_CLOTURE = ['Simple demande de renseignement'];   /* + « Autre », avec le contexte en saisie libre */
const MOTIFS_ABANDON = ['Rétractation', 'Condition suspensive non réalisée', 'Refus de prêt', 'Vente à un tiers'];
const GRACE_JOURS = 30;
const LIBELLES_ECHEANCE = ['Levée des conditions suspensives', 'Obtention du prêt', 'Date butoir de réitération'];

function codeValide(recu, variable) {
  const attendu = process.env[variable || 'SUIVI_CODE_ADMIN'] || '';
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
// Répartition des adresses : correspondants d'un côté, étude de l'autre (21/10/2026)
function repartir(liste) {
  const tiers = [], etude = [];
  adresses(liste).forEach(a => { if (types.estEtude(a)) etude.push(a); else if (a !== types.MOI) tiers.push(a); });
  return { tiers, etude };
}
function nomOutlook(d) {
  const p1 = (d.partie1 || '').toUpperCase(), p2 = (d.partie2 || '').toUpperCase();
  return [d.numero, p2 ? p1 + ' / ' + p2 : p1].filter(Boolean).join(' ');
}
function erreur(res, code, message) { res.status(code).json({ erreur: message }); }
const libelle = { en_cours: 'En cours', avant_contrat: 'Avant-contrat', signe: 'Signé', abandonne: 'Abandonné', clos: 'Clos' };
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
    'date_ouverture', 'date_deces', 'prochaine_echeance', 'date_limite']) {
    if (x[k] instanceof Date) x[k] = x[k].toISOString().slice(0, 10);
  }
  return x;
}

async function traiter(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  // Lecture des réponses aux arbitrages par Claude : clé de lecture seule, distincte du code de JFD
  if (req.method === 'GET' && (req.query || {}).action === 'arbitrages_claude') {
    if (!process.env.SUIVI_CODE_LECTURE) return erreur(res, 503, 'Lecture non configurée (variable SUIVI_CODE_LECTURE absente).');
    if (!codeValide(req.headers['x-suivi-lecture'] || (req.query || {}).lecture, 'SUIVI_CODE_LECTURE')) {
      await new Promise(r => setTimeout(r, sqlInjecte ? 0 : 400));
      return erreur(res, 401, 'Clé de lecture incorrecte.');
    }
    return res.json(await arb.pourClaude(db(), (req.query || {}).depuis));
  }
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
    return res.json({ aujourdhui: jour, jour: cal.infoJour(jour), couleur_du_temps: cal.couleurDuTemps(jour), motifs_abandon: MOTIFS_ABANDON, motifs_cloture: MOTIFS_CLOTURE, libelles_echeance: LIBELLES_ECHEANCE });
  }
  if (req.method === 'GET' && action === 'liste') {
    const l = await liste(sql, jour);
    let releves = null;
    try { releves = await pont.etatReleves(sql); } catch (e) { releves = null; } // tables du pont pas encore créées
    let propositions = null;
    try { propositions = await props.compter(sql); } catch (e) { propositions = null; } // suivi-7.sql pas encore exécuté
    let arbitrages = null;
    try { arbitrages = await arb.compter(sql); } catch (e) { arbitrages = null; } // suivi-8.sql pas encore exécuté
    return res.json({ aujourdhui: jour, ...l, releves, propositions, arbitrages });
  }
  // Pont provisoire : identifiants Drive des fiches déjà reprises (14 derniers jours)
  if (req.method === 'GET' && action === 'releves_repris') {
    const r = await sql`SELECT drive_id FROM suivi_releve WHERE repris_le > now() - interval '14 days'`;
    return res.json({ ids: r.map(x => x.drive_id) });
  }
  if (req.method === 'GET' && action === 'a_rattacher') return res.json({ mails: await pont.aRattacher(sql) });
  // Module de création : fiches proposées à partir du balayage
  if (req.method === 'GET' && action === 'propositions_reprises') {
    const r = await sql`SELECT drive_id FROM suivi_proposition_lot`;
    return res.json({ ids: r.map(x => x.drive_id) });
  }
  if (req.method === 'GET' && action === 'propositions') return res.json({ propositions: await props.lister(sql) });
  // Arbitrages du balayage (26/10/2026)
  if (req.method === 'GET' && action === 'arbitrages_repris') {
    const r = await sql`SELECT drive_id FROM suivi_arbitrage_lot`;
    return res.json({ ids: r.map(x => x.drive_id) });
  }
  if (req.method === 'GET' && action === 'arbitrages') return res.json(await arb.lister(sql));
  if (req.method === 'GET' && action === 'dossier') {
    const id = +q.id;
    const [d] = await sql`SELECT * FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    const evenements = await sql`SELECT * FROM suivi_evenement WHERE dossier_id = ${id} ORDER BY date_evt DESC, id DESC`;
    const rappels = await sql`SELECT * FROM suivi_rappel WHERE dossier_id = ${id} ORDER BY fait_le NULLS FIRST, echeance, id`;
    const echeances = await sql`SELECT * FROM suivi_echeance WHERE dossier_id = ${id} ORDER BY faite_le NULLS FIRST, echeance, id`;
    return res.json({ dossier: { ...versChaines(d), nom_outlook: nomOutlook(d) }, evenements: evenements.map(versChaines), rappels: rappels.map(versChaines), echeances: echeances.map(versChaines) });
  }
  if (req.method === 'GET' && action === 'collaborateurs') {
    const liste = await sql`SELECT adresse, nom, prenom, site, importe_le FROM suivi_collaborateur ORDER BY nom, prenom`;
    return res.json({ collaborateurs: liste });
  }
  if (req.method !== 'POST') return erreur(res, 405, 'Action inconnue.');

  // Import de la liste des collaborateurs (fichier Excel lu dans le navigateur) : remplace la liste
  if (action === 'importer_collaborateurs') {
    const vus = new Set(), A = [], N = [], P = [], S = [];
    (Array.isArray(b.liste) ? b.liste : []).slice(0, 1000).forEach(x => {
      const a = (adresses([x && x.adresse])[0]) || '', nom = texte(x && x.nom, 80);
      if (!nom || !a.endsWith('@fidal.notaires.fr') || vus.has(a)) return;
      vus.add(a); A.push(a); N.push(nom); P.push(texte(x.prenom, 80)); S.push(texte(x.site, 60));
    });
    if (!A.length) return erreur(res, 400, 'Aucun collaborateur lisible dans le fichier (colonnes « nom » et « mail » attendues).');
    await sql`DELETE FROM suivi_collaborateur`;
    await sql`INSERT INTO suivi_collaborateur (adresse, nom, prenom, site) SELECT * FROM unnest(${A}::text[], ${N}::text[], ${P}::text[], ${S}::text[])`;
    return res.json({ importes: A.length });
  }


  if (action === 'creer' || action === 'modifier') {
    const r1 = repartir(b.adresses), r2 = repartir(Array.isArray(b.etude) ? b.etude : []);
    const etude = [...new Set(r1.etude.concat(r2.etude))];
    const relances = adresses(Array.isArray(b.relances) ? b.relances : []).filter(a => etude.includes(a) && !types.estPartagee(a));
    const champs = {
      intitule: texte(b.intitule, 200), partie1: texte(b.partie1, 120), partie2: texte(b.partie2, 120),
      numero: texte(b.numero, 40), adresses: r1.tiers.concat(r2.tiers.filter(a => !r1.tiers.includes(a))), signature_prevue: date(b.signature_prevue),
      etude, etude_relances: relances,
      collaborateur: null, collab_relances: false,   /* remplacés par le bloc « Étude » */
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
    if (action === 'creer') {
      const etape = b.etape === 'avant_contrat' ? 'avant_contrat' : 'en_cours';
      const [d] = await sql`INSERT INTO suivi_dossier (intitule, partie1, partie2, numero, adresses, etape, signature_prevue, collaborateur, collab_relances,
          type_dossier, date_ouverture, date_deces, delai_jours, etude, etude_relances)
        VALUES (${champs.intitule}, ${champs.partie1}, ${champs.partie2}, ${champs.numero}, ${champs.adresses}, ${etape}, ${champs.signature_prevue}, ${champs.collaborateur}, ${champs.collab_relances},
          ${champs.type_dossier}, ${champs.date_ouverture}, ${champs.date_deces}, ${champs.delai_jours}, ${champs.etude}, ${champs.etude_relances})
        RETURNING *`;
      await evenement(sql, d.id, 'creation', 'Dossier créé — ' + t.nom + ', ouvert le ' + fr(champs.date_ouverture) + ' (dossier Outlook : « ' + nomOutlook(d) + ' »)', champs.date_ouverture);
      if (b.mail) { const l = ligneMail(b.mail); await evenement(sql, d.id, 'note', l.texte, l.jour || jour); }
      // dossier créé depuis « à rattacher » : le mail relevé y est rattaché (rattachement à la main, adresses apprises)
      if (b.mail_outlook) await pont.rattacherMain(sql, texte(b.mail_outlook, 500), d.id);
      // dossier créé depuis une fiche proposée par le balayage : la fiche est marquée validée
      if (b.proposition) {
        const p = await props.marquer(sql, b.proposition, 'valide', d.id);
        if (p) await evenement(sql, d.id, 'note', 'Créé à partir de la fiche proposée par le balayage des mails' + (p.sources && p.sources.length ? ' (tranches ' + p.sources.join(', ') + ')' : '') + (p.resume ? ' — ' + p.resume : ''), champs.date_ouverture);
      }
      return res.json({ dossier: { ...versChaines(d), nom_outlook: nomOutlook(d) } });
    }
    const id = +b.id;
    const [d] = await sql`UPDATE suivi_dossier SET intitule = ${champs.intitule}, partie1 = ${champs.partie1}, partie2 = ${champs.partie2},
        numero = ${champs.numero}, adresses = ${champs.adresses}, signature_prevue = ${champs.signature_prevue},
        collaborateur = ${champs.collaborateur}, collab_relances = ${champs.collab_relances},
        type_dossier = ${champs.type_dossier}, date_ouverture = ${champs.date_ouverture}, date_deces = ${champs.date_deces}, delai_jours = ${champs.delai_jours},
        etude = ${champs.etude}, etude_relances = ${champs.etude_relances}, maj_le = now()
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
    } else if (cible === 'clos') {
      const motif = texte(b.motif, 300);
      if (!motif) return erreur(res, 400, 'Le motif de clôture est obligatoire.');
      if (d.etape === 'clos') return erreur(res, 409, 'Ce dossier est déjà clos.');
      [maj] = await sql`UPDATE suivi_dossier SET etape = 'clos', motif_cloture = ${motif}, classe_le = ${le}, maj_le = now() WHERE id = ${id} RETURNING *`;
      // les adresses restent rattachées 30 jours après la clôture, comme après une signature
      await evenement(sql, id, 'etape', 'Dossier clos le ' + fr(le) + ' — motif : ' + motif + ' ; adresses rattachées jusqu’au ' + fr(cal.decaler(le, GRACE_JOURS)), le);
    } else if (cible === 'abandonne') {
      const motif = texte(b.motif, 200);
      if (!motif) return erreur(res, 400, 'Le motif d’abandon est obligatoire.');
      [maj] = await sql`UPDATE suivi_dossier SET etape = 'abandonne', motif_abandon = ${motif}, classe_le = ${le}, maj_le = now() WHERE id = ${id} RETURNING *`;
      await evenement(sql, id, 'etape', 'Dossier abandonné le ' + fr(le) + ' — motif : ' + motif, le);
    } else {
      const rouvert = d.etape === 'clos';
      [maj] = await sql`UPDATE suivi_dossier SET etape = ${cible}, signature_le = NULL, classe_le = NULL, motif_cloture = NULL, maj_le = now() WHERE id = ${id} RETURNING *`;
      await evenement(sql, id, 'etape', (rouvert ? 'Dossier rouvert le ' + fr(le) + ', étape « ' : 'Étape « ') + libelle[cible] + (rouvert ? ' »' : ' » le ' + fr(le)), le);
    }
    return res.json({ dossier: { ...versChaines(maj), nom_outlook: nomOutlook(maj) } });
  }

  // Réajustement de la date limite d'un dossier (clic sur le sablier) : motif obligatoire
  if (action === 'delai_reporter') {
    const id = +b.id, nouvelle = date(b.date), motif = texte(b.motif, 500);
    if (!nouvelle) return erreur(res, 400, 'La nouvelle date limite est obligatoire.');
    if (nouvelle < jour) return erreur(res, 400, 'La nouvelle date limite ne peut pas être passée.');
    if (!motif) return erreur(res, 400, 'Le motif du report est obligatoire.');
    const [d] = await sql`SELECT * FROM suivi_dossier WHERE id = ${id}`;
    if (!d) return erreur(res, 404, 'Dossier introuvable.');
    if (d.signature_le || ['abandonne', 'clos', 'formalites'].includes(d.etape)) return erreur(res, 409, 'Ce dossier n’a plus de délai à suivre.');
    const ancienne = types.delais(versChaines(d), jour).fin;
    if (nouvelle === ancienne) return erreur(res, 400, 'La nouvelle date est identique à la date limite actuelle.');
    const [maj] = await sql`UPDATE suivi_dossier SET date_limite = ${nouvelle}, maj_le = now() WHERE id = ${id} RETURNING *`;
    await evenement(sql, id, 'delai', 'Date limite reportée du ' + fr(ancienne) + ' au ' + fr(nouvelle) + ' — motif : ' + motif, jour);
    return res.json({ dossier: { ...versChaines(maj), nom_outlook: nomOutlook(maj) }, ancienne });
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
    const nouv = repartir(b.adresses);
    if (nouv.tiers.length) await sql`UPDATE suivi_dossier SET adresses = (SELECT array_agg(DISTINCT x) FROM unnest(adresses || ${nouv.tiers}::text[]) AS x), maj_le = now() WHERE id = ${id}`;
    if (nouv.etude.length) await sql`UPDATE suivi_dossier SET etude = (SELECT array_agg(DISTINCT x) FROM unnest(etude || ${nouv.etude}::text[]) AS x), maj_le = now() WHERE id = ${id}`;
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

  // Pont provisoire : reprise d'un lot de fiches lues dans le Drive par la page
  if (action === 'releves') {
    const bilan = await pont.importer(sql, b.fiches, jour);
    const etatR = await pont.etatReleves(sql);
    await pont.signalerManques(sql, etatR);
    return res.json({ bilan, releves: etatR });
  }
  if (action === 'propositions') {
    const bilan = await props.importer(sql, b.fichiers);
    return res.json({ bilan, propositions: await props.compter(sql) });
  }
  if (action === 'arbitrages') {
    const bilan = await arb.importer(sql, b.fichiers);
    return res.json({ bilan, arbitrages: await arb.compter(sql) });
  }
  if (action === 'arbitrage_repondre') {
    const r = await arb.repondre(sql, b.id, texte(b.reponse, 200), b.libre, b.commentaire);
    return r.erreur ? erreur(res, 400, r.erreur) : res.json(r);
  }
  if (action === 'arbitrage_appliquer') {
    const r = await arb.appliquer(sql, b.id, b.elements, b.garder, b.intitule, jour);
    return r.erreur ? erreur(res, 400, r.erreur) : res.json(r);
  }
  if (action === 'proposition_ecarter') {
    const p = await props.marquer(sql, b.cle, 'ecarte', null);
    return p ? res.json({ ok: true }) : erreur(res, 404, 'Fiche introuvable ou déjà tranchée.');
  }
  if (action === 'proposition_fusionner') {
    const r = await props.fusionner(sql, b.cle, +b.id);
    if (r.erreur) return erreur(res, 404, r.erreur);
    await evenement(sql, +b.id, 'note', 'Fiche « ' + r.proposition.intitule + ' » du balayage des mails fusionnée dans ce dossier (adresses reprises)', jour);
    return res.json({ ok: true });
  }
  if (action === 'mail_rattacher') {
    const r = await pont.rattacherMain(sql, texte(b.mail_id, 500), +b.id);
    return r.erreur ? erreur(res, 404, r.erreur) : res.json(r);
  }
  if (action === 'mail_ignorer') {
    const r = await pont.ignorer(sql, texte(b.mail_id, 500));
    return r.erreur ? erreur(res, 404, r.erreur) : res.json(r);
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
