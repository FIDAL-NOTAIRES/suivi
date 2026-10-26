/* SUIVI — arbitrages du balayage (arbitrages du 26/10/2026, PC, soir).
   Claude dépose dans le dossier Drive « SUIVI – relevés » des fichiers « arbitrages-NN.json » : une question par
   arbitrage, posée par les INTITULÉS des dossiers. La page les lit par le relais Drive et les envoie ici.
   Trois natures :
   - « meme_dossier » : ces dossiers sont-ils le même ? boutons Même dossier / Dossiers distincts / À revoir ;
   - « question »     : question ouverte, réponses toutes prêtes + « Autre » (ligne libre) + À revoir ;
   - « a_appliquer »  : décision déjà prise à l'oral (fusion ou renommage), à appliquer d'un clic.
   « Même dossier » ouvre aussitôt l'écran de fusion ; si un dossier n'est pas encore dans SUIVI, la réponse est
   seulement enregistrée et Claude la traite au lot suivant.
   Les réponses sont relues par Claude par une adresse en lecture seule (clé SUIVI_CODE_LECTURE).
   Règles : un arbitrage est repéré par son identifiant (jamais repris deux fois) ; une fusion déplace TOUT le
   contenu du dossier absorbé (chronologie, rappels, échéances, mails, adresses) avant de le supprimer. */
'use strict';
const props = require('./propositions.js');

const NATURES = ['meme_dossier', 'question', 'a_appliquer'];
const OPERATIONS = ['fusion', 'renommage'];

function txt(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max || 300) : null;
}
function jour(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v.slice(0, 10))) ? v.slice(0, 10) : null; }
function liste(v, n, max) {
  return (Array.isArray(v) ? v : []).map(x => txt(x, max)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, n);
}

function arbitrageDeFichier(a) {
  if (!a || typeof a !== 'object') return null;
  const id = txt(a.id, 60), nature = NATURES.includes(a.nature) ? a.nature : null;
  if (!id || !nature) return null;
  const dossiers = liste(a.dossiers, 6, 200).map(x => x.toUpperCase());
  const r = {
    id, nature, dossiers,
    question: txt(a.question, 400), contexte: txt(a.contexte, 1200),
    reponses: nature === 'question' ? liste(a.reponses, 6, 200) : [],
    operation: nature === 'a_appliquer' ? (OPERATIONS.includes(a.operation) ? a.operation : null) : null,
    intitule_final: txt(a.intitule_final, 200) ? txt(a.intitule_final, 200).toUpperCase() : null,
    decide_le: jour(a.decide_le)
  };
  if (nature === 'meme_dossier' && dossiers.length < 2) return null;
  if (nature === 'question' && !r.question) return null;
  if (nature === 'a_appliquer') {
    if (!r.operation) return null;
    if (r.operation === 'fusion' && dossiers.length < 2) return null;
    if (r.operation === 'renommage' && (dossiers.length !== 1 || !r.intitule_final)) return null;
  }
  if (!r.question) r.question = nature === 'meme_dossier' ? 'Ces dossiers sont-ils le même dossier ?' :
    (r.operation === 'fusion' ? 'Fusion décidée' : 'Renommage décidé');
  return r;
}

async function importer(sql, fichiers) {
  const bilan = { fichiers: 0, deja: 0, nouveaux: 0, connus: 0, illisibles: 0 };
  for (const f of (Array.isArray(fichiers) ? fichiers : []).slice(0, 10)) {
    const driveId = txt(f && f.drive_id, 200);
    if (!driveId) continue;
    const c = f.contenu && typeof f.contenu === 'object' ? f.contenu : null;
    const l = c && Array.isArray(c.arbitrages) ? c.arbitrages.slice(0, 300).map(arbitrageDeFichier).filter(Boolean) : [];
    const ins = await sql`INSERT INTO suivi_arbitrage_lot (drive_id, nom, nb) VALUES (${driveId}, ${txt(f.nom, 200)}, ${l.length})
      ON CONFLICT (drive_id) DO NOTHING RETURNING drive_id`;
    if (!ins.length) { bilan.deja++; continue; }
    bilan.fichiers++;
    if (!c) { bilan.illisibles++; continue; }
    for (const a of l) {
      const r = await sql`INSERT INTO suivi_arbitrage (id, lot, nature, question, contexte, dossiers, reponses, operation, intitule_final, decide_le)
        VALUES (${a.id}, ${driveId}, ${a.nature}, ${a.question}, ${a.contexte}, ${a.dossiers}, ${a.reponses}, ${a.operation}, ${a.intitule_final}, ${a.decide_le})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (r.length) bilan.nouveaux++; else bilan.connus++;
    }
  }
  return bilan;
}

/* Où se trouve un intitulé dans SUIVI : dossier, fiche proposée en attente, ou nulle part */
async function index(sql) {
  const dossiers = await sql`SELECT id, intitule, classe_le, etape FROM suivi_dossier`;
  const fiches = await sql`SELECT cle, intitule, etat, dossier_id FROM suivi_proposition`;
  const parCle = {};
  dossiers.forEach(d => { const k = props.cle(d.intitule); if (!parCle[k]) parCle[k] = d; });
  const ids = {}; dossiers.forEach(d => { ids[d.id] = d; });
  const fichesParCle = {}; fiches.forEach(f => { fichesParCle[f.cle] = f; });
  return function situer(intitule) {
    const k = props.cle(intitule);
    if (parCle[k]) return { intitule, sorte: 'dossier', id: parCle[k].id, intitule_actuel: parCle[k].intitule };
    const f = fichesParCle[k];
    if (f && f.dossier_id && ids[f.dossier_id]) return { intitule, sorte: 'dossier', id: f.dossier_id, intitule_actuel: ids[f.dossier_id].intitule };
    if (f && f.etat === 'propose') return { intitule, sorte: 'proposition', cle: f.cle, intitule_actuel: f.intitule };
    return { intitule, sorte: null, ecartee: !!(f && f.etat === 'ecarte') };
  };
}

function versChaines(r) {
  const x = { ...r };
  for (const k of ['decide_le']) if (x[k] instanceof Date) x[k] = x[k].toISOString().slice(0, 10);
  for (const k of ['repondu_le', 'applique_le', 'cree_le']) if (x[k] instanceof Date) x[k] = x[k].toISOString();
  return x;
}
/* À appliquer : décision orale pas encore appliquée, ou « Même dossier » répondu mais fusion pas encore faite */
const A_APPLIQUER = "(nature = 'a_appliquer' AND etat = 'ouvert') OR (nature = 'meme_dossier' AND etat = 'repondu' AND reponse = 'meme')";

async function lister(sql) {
  const situer = await index(sql);
  const tous = await sql`SELECT * FROM suivi_arbitrage
    WHERE etat IN ('ouvert','a_revoir','repondu') OR applique_le > now() - interval '30 days' OR repondu_le > now() - interval '30 days'
    ORDER BY cree_le, id`;
  const l = tous.map(versChaines).map(a => ({ ...a, situation: (a.dossiers || []).map(situer) }));
  const appliquer = a => (a.nature === 'a_appliquer' && a.etat === 'ouvert') || (a.nature === 'meme_dossier' && a.etat === 'repondu' && a.reponse === 'meme');
  return {
    a_trancher: l.filter(a => a.nature !== 'a_appliquer' && (a.etat === 'ouvert' || a.etat === 'a_revoir'))
      .sort((x, y) => (x.etat === 'a_revoir') - (y.etat === 'a_revoir')),
    a_appliquer: l.filter(appliquer),
    recents: l.filter(a => !appliquer(a) && (a.etat === 'repondu' || a.etat === 'applique'))
      .sort((x, y) => String(y.applique_le || y.repondu_le).localeCompare(String(x.applique_le || x.repondu_le)))
  };
}
async function compter(sql) {
  const [n] = await sql`SELECT count(*)::int AS n FROM suivi_arbitrage
    WHERE (nature <> 'a_appliquer' AND etat IN ('ouvert','a_revoir'))
       OR (nature = 'a_appliquer' AND etat = 'ouvert')
       OR (nature = 'meme_dossier' AND etat = 'repondu' AND reponse = 'meme')`;
  return n.n;
}

/* Réponse de JFD : meme | distincts | a_revoir | une réponse toute prête | autre (ligne libre) */
async function repondre(sql, id, reponse, libre, commentaire) {
  const [a] = await sql`SELECT * FROM suivi_arbitrage WHERE id = ${txt(id, 60)}`;
  if (!a) return { erreur: 'Arbitrage introuvable.' };
  if (a.nature === 'a_appliquer') return { erreur: 'Cette décision est déjà prise : il reste seulement à l’appliquer.' };
  if (a.etat === 'applique') return { erreur: 'Cet arbitrage est déjà appliqué.' };
  const com = txt(commentaire, 500);
  if (reponse === 'a_revoir') {
    const [r] = await sql`UPDATE suivi_arbitrage SET etat = 'a_revoir', reponse = NULL, reponse_libre = NULL,
        commentaire = coalesce(${com}, commentaire), repondu_le = now() WHERE id = ${a.id} RETURNING *`;
    return { arbitrage: versChaines(r) };
  }
  let rep = null, lib = null;
  if (a.nature === 'meme_dossier') {
    if (reponse !== 'meme' && reponse !== 'distincts') return { erreur: 'Réponse inconnue.' };
    rep = reponse;
  } else if (reponse === 'autre') {
    lib = txt(libre, 300);
    if (!lib) return { erreur: 'Écrivez la réponse dans la ligne « Autre ».' };
    rep = 'autre';
  } else {
    if (!(a.reponses || []).includes(reponse)) return { erreur: 'Réponse inconnue.' };
    rep = reponse;
  }
  const [r] = await sql`UPDATE suivi_arbitrage SET etat = 'repondu', reponse = ${rep}, reponse_libre = ${lib},
      commentaire = ${com}, repondu_le = now() WHERE id = ${a.id} RETURNING *`;
  return { arbitrage: versChaines(r) };
}

/* ---------- Application : fusion ou renommage ----------
   elements : [{ sorte: 'dossier', id } | { sorte: 'proposition', cle }] ; garder : indice de l'élément conservé.
   Un dossier l'emporte toujours sur une fiche proposée (la fiche y est versée). */
async function fusionnerDossiers(sql, garderId, autreId, jourEvt, intituleAutre) {
  const note = 'Dossier « ' + intituleAutre + ' » fusionné dans ce dossier (arbitrage du balayage) : chronologie, rappels, échéances, mails et adresses repris';
  const requetes = [
    sql`UPDATE suivi_evenement SET dossier_id = ${garderId} WHERE dossier_id = ${autreId}`,
    sql`UPDATE suivi_rappel SET dossier_id = ${garderId} WHERE dossier_id = ${autreId}`,
    sql`UPDATE suivi_echeance SET dossier_id = ${garderId} WHERE dossier_id = ${autreId}`,
    sql`UPDATE suivi_mail SET dossier_id = ${garderId} WHERE dossier_id = ${autreId}`,
    sql`UPDATE suivi_proposition SET dossier_id = ${garderId} WHERE dossier_id = ${autreId}`,
    sql`UPDATE suivi_dossier AS g SET
        adresses = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.adresses || a.adresses) AS x),
        etude = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.etude || a.etude) AS x),
        etude_relances = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.etude_relances || a.etude_relances) AS x),
        partie2 = coalesce(g.partie2, a.partie2), numero = coalesce(g.numero, a.numero),
        signature_prevue = coalesce(g.signature_prevue, a.signature_prevue),
        date_ouverture = LEAST(g.date_ouverture, a.date_ouverture), maj_le = now()
      FROM suivi_dossier AS a WHERE g.id = ${garderId} AND a.id = ${autreId}`,
    sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt) VALUES (${garderId}, 'note', ${note}, ${jourEvt})`,
    sql`DELETE FROM suivi_dossier WHERE id = ${autreId}`
  ];
  if (typeof sql.transaction === 'function') await sql.transaction(requetes);
  else for (const q of requetes) await q;
}

async function appliquer(sql, id, elements, garder, intitule, jourEvt) {
  const [a] = await sql`SELECT * FROM suivi_arbitrage WHERE id = ${txt(id, 60)}`;
  if (!a) return { erreur: 'Arbitrage introuvable.' };
  const enAttente = (a.nature === 'a_appliquer' && a.etat === 'ouvert') || (a.nature === 'meme_dossier' && a.etat === 'repondu' && a.reponse === 'meme');
  if (!enAttente) return { erreur: 'Cet arbitrage n’attend pas d’application.' };
  const operation = a.nature === 'a_appliquer' ? a.operation : 'fusion';
  const titre = txt(intitule, 200) ? txt(intitule, 200).toUpperCase() : null;
  if (!titre) return { erreur: 'Indiquez l’intitulé à garder.' };

  // éléments choisis à l'écran, vérifiés en base, sans doublon
  const vus = {}, els = [];
  const entree = (Array.isArray(elements) ? elements : []).slice(0, 6);
  for (let i = 0; i < entree.length; i++) {
    const e = entree[i];
    if (e && e.sorte === 'dossier' && +e.id > 0) {
      const k = 'd' + (+e.id); if (vus[k]) continue;
      const [d] = await sql`SELECT id, intitule FROM suivi_dossier WHERE id = ${+e.id}`;
      if (!d) return { erreur: 'Un des dossiers choisis n’existe plus. Rechargez la page.' };
      vus[k] = 1; els.push({ sorte: 'dossier', id: d.id, intitule: d.intitule, choisi: i === +garder });
    } else if (e && e.sorte === 'proposition' && txt(e.cle, 200)) {
      const k = 'p' + e.cle; if (vus[k]) continue;
      const [p] = await sql`SELECT cle, intitule, etat FROM suivi_proposition WHERE cle = ${txt(e.cle, 200)}`;
      if (!p || p.etat !== 'propose') return { erreur: 'Une des fiches proposées choisies a déjà été tranchée. Rechargez la page.' };
      vus[k] = 1; els.push({ sorte: 'proposition', cle: p.cle, intitule: p.intitule, choisi: i === +garder });
    }
  }
  const fait = [];
  if (operation === 'renommage') {
    if (els.length !== 1) return { erreur: 'Choisissez le dossier à renommer.' };
    const e = els[0];
    if (e.sorte === 'dossier') {
      await sql`UPDATE suivi_dossier SET intitule = ${titre}, maj_le = now() WHERE id = ${e.id}`;
      await sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt) VALUES (${e.id}, 'note', ${'Dossier renommé (arbitrage du balayage) : « ' + e.intitule + ' » devient « ' + titre + ' »'}, ${jourEvt})`;
    } else await sql`UPDATE suivi_proposition SET intitule = ${titre} WHERE cle = ${e.cle}`;
    fait.push('« ' + e.intitule + ' » renommé « ' + titre + ' »');
  } else {
    if (els.length < 2) return { erreur: 'Une fusion demande au moins deux dossiers.' };
    let g = els.find(e => e.choisi) || els[0];
    // un dossier l'emporte toujours sur une fiche proposée
    if (g.sorte === 'proposition' && els.some(e => e.sorte === 'dossier')) return { erreur: 'Le dossier à garder doit être un dossier déjà dans SUIVI, pas une fiche proposée.' };
    for (const e of els) {
      if (e === g) continue;
      if (g.sorte === 'dossier' && e.sorte === 'dossier') await fusionnerDossiers(sql, g.id, e.id, jourEvt, e.intitule);
      else if (g.sorte === 'dossier' && e.sorte === 'proposition') {
        const r = await props.fusionner(sql, e.cle, g.id);
        if (r.erreur) return r;
        await sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt) VALUES (${g.id}, 'note', ${'Fiche « ' + e.intitule + ' » du balayage des mails fusionnée dans ce dossier (arbitrage du balayage, adresses reprises)'}, ${jourEvt})`;
      } else {
        // deux fiches proposées : la seconde est versée dans la première, qui reste à valider
        await sql`UPDATE suivi_proposition AS g SET
            adresses = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.adresses || a.adresses) AS x),
            etude = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.etude || a.etude) AS x),
            sources = (SELECT coalesce(array_agg(DISTINCT x), '{}') FROM unnest(g.sources || a.sources) AS x),
            date_ouverture = LEAST(g.date_ouverture, a.date_ouverture), dernier_mail = GREATEST(g.dernier_mail, a.dernier_mail),
            partie2 = coalesce(g.partie2, a.partie2), numero = coalesce(g.numero, a.numero), urgent = g.urgent OR a.urgent
          FROM suivi_proposition AS a WHERE g.cle = ${g.cle} AND a.cle = ${e.cle}`;
        await props.marquer(sql, e.cle, 'fusionne', null);
      }
      fait.push('« ' + e.intitule + ' » fusionné dans « ' + g.intitule + ' »');
    }
    if (props.cle(titre) !== props.cle(g.intitule)) {
      if (g.sorte === 'dossier') {
        await sql`UPDATE suivi_dossier SET intitule = ${titre}, maj_le = now() WHERE id = ${g.id}`;
        await sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt) VALUES (${g.id}, 'note', ${'Dossier renommé à la fusion : « ' + g.intitule + ' » devient « ' + titre + ' »'}, ${jourEvt})`;
      } else await sql`UPDATE suivi_proposition SET intitule = ${titre} WHERE cle = ${g.cle}`;
      fait.push('intitulé gardé : « ' + titre + ' »');
    }
  }
  const [r] = await sql`UPDATE suivi_arbitrage SET etat = 'applique', applique_le = now(), applique_detail = ${fait.join(' ; ')}
    WHERE id = ${a.id} RETURNING *`;
  return { ok: true, arbitrage: versChaines(r), fait };
}

/* ---------- Lecture par Claude (clé SUIVI_CODE_LECTURE) ---------- */
function libelleReponse(a) {
  if (a.etat === 'a_revoir') return 'À revoir';
  if (a.etat === 'applique') return 'Appliqué' + (a.applique_detail ? ' : ' + a.applique_detail : '');
  if (a.reponse === 'meme') return 'Même dossier (fusion pas encore appliquée)';
  if (a.reponse === 'distincts') return 'Dossiers distincts';
  if (a.reponse === 'autre') return 'Autre : ' + (a.reponse_libre || '');
  return a.reponse || 'Sans réponse';
}
function texteClaude(l) {
  const lignes = l.map(a => '- [' + a.id + '] ' + a.question + (a.dossiers && a.dossiers.length ? ' (' + a.dossiers.join(' / ') + ')' : '') +
    ' → ' + libelleReponse(a) + (a.commentaire ? ' — commentaire : ' + a.commentaire : '') +
    ' (' + String(a.applique_le || a.repondu_le || '').slice(0, 10) + ')');
  return lignes.length ? 'Réponses aux arbitrages du balayage, saisies dans SUIVI :\n' + lignes.join('\n') : 'Aucune réponse aux arbitrages dans SUIVI pour l’instant.';
}
async function pourClaude(sql, depuis) {
  const d = jour(depuis) || '2000-01-01';
  const l = (await sql`SELECT * FROM suivi_arbitrage
    WHERE etat IN ('repondu','a_revoir','applique') AND greatest(repondu_le, applique_le) >= ${d}::date
    ORDER BY greatest(repondu_le, applique_le), id`).map(versChaines);
  const [n] = await sql`SELECT count(*)::int AS n FROM suivi_arbitrage WHERE etat = 'ouvert'`;
  return { reponses: l, sans_reponse: n.n, texte: texteClaude(l) };
}

module.exports = { arbitrageDeFichier, importer, lister, compter, repondre, appliquer, pourClaude, texteClaude, libelleReponse };
