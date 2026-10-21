/* SUIVI — pont PROVISOIRE de lecture des mails (arbitrages du 21/10/2026).
   Des tâches programmées Claude lisent la messagerie et déposent, à chaque relevé,
   une fiche JSON dans le dossier Drive « SUIVI – relevés ». La page de SUIVI lit les
   fiches nouvelles avec le jeton Drive de l'utilisateur et les envoie ici.
   Règles appliquées :
   - une fiche n'est jamais reprise deux fois (identifiant Drive), un mail jamais compté deux fois (identifiant Outlook) ;
   - rattachement : dossier pressenti si la certitude est « sûr » et qu'il correspond à UN dossier ouvert,
     sinon adresse liée à UN SEUL dossier ouvert, sinon « à rattacher » ; une certitude « incertain » va toujours à « à rattacher » ;
   - RÈGLE DE PRUDENCE : l'import n'apprend aucune adresse ; seul un rattachement fait à la main en ajoute ;
   - au 2e mail ignoré d'un même expéditeur, ses mails suivants sont écartés d'office ;
   - trois relevés manqués d'affilée ouvrent un incident (bandeau commun), clos dès que les relevés reprennent.
   Grille des relevés : jours ouvrés de 7 h à 20 h toutes les heures ; week-ends, fêtes et solennités à 8 h, 9 h, 19 h, 20 h. */
'use strict';
const cal = require('./calendrier.js');
const types = require('./types.js');

const DOMAINE_ETUDE = '@fidal.notaires.fr';
const FORMES = /\b(sci|sas|sasu|sarl|sa|snc|eurl|scp|selarl|selas|gfa|sccv|scpi|ste|societe|cie|et cie)\b/g;
const HEURES_OUVRE = [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const HEURES_CHOME = [8, 9, 19, 20];
const SEUIL_MANQUES = 3;
const MAX_MAILS = 300;

function txt(v, max) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max || 300) : null;
}
function adresse(v) {
  const s = String(v || '').trim().toLowerCase();
  const m = s.match(/[^\s<>"',;]+@[^\s<>"',;]+\.[^\s<>"',;]+/);
  return m ? m[0] : null;
}
function liste(v, max) {
  const l = (Array.isArray(v) ? v : [v]).map(adresse).filter(Boolean);
  return [...new Set(l)].slice(0, max || 50);
}
function noms(v) {
  return (Array.isArray(v) ? v : []).map(x => txt(x, 200)).filter(Boolean).slice(0, 30);
}
function instant(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : new Date(t).toISOString();
}
// « VENTE SCI Dupont / MARTIN » → « vente dupont martin »
function normaliser(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').replace(FORMES, ' ').replace(/\s+/g, ' ').trim();
}
function estEtude(a) { return !!a && a.endsWith(DOMAINE_ETUDE); }   /* JFD compris : jamais un correspondant */
function adressesExternes(m) {
  return [...new Set([m.expediteur, ...m.destinataires, ...m.copies].filter(a => a && !estEtude(a)))];
}
function dossierOuvert(d, jour) {
  return d.etape !== 'abandonne' && d.etape !== 'clos' && (!d.classe_le || String(d.classe_le instanceof Date ? d.classe_le.toISOString() : d.classe_le).slice(0, 10) > jour);
}
function nomOutlook(d) {
  const p1 = (d.partie1 || '').toUpperCase(), p2 = (d.partie2 || '').toUpperCase();
  return [d.numero, p2 ? p1 + ' / ' + p2 : p1].filter(Boolean).join(' ');
}

// Un mail de la fiche, nettoyé (rien d'autre que la synthèse prévue au format v1)
function mailDeFiche(m) {
  if (!m || typeof m !== 'object') return null;
  const id = txt(m.id_outlook, 500);
  if (!id) return null;
  const r = m.reponse_attendue && typeof m.reponse_attendue === 'object' ? m.reponse_attendue : {};
  const ch = m.changements && typeof m.changements === 'object' ? m.changements : {};
  const sig = typeof ch.date_signature === 'string' && /^\d{4}-\d{2}-\d{2}/.test(ch.date_signature) ? ch.date_signature.slice(0, 10) : null;
  return {
    id_outlook: id,
    sens: m.sens === 'envoyé' || m.sens === 'envoye' ? 'envoyé' : 'reçu',
    date_mail: instant(m.date),
    expediteur: adresse(m.expediteur),
    destinataires: liste(m.destinataires),
    copies: liste(m.copies),
    etude: liste(m.etude),
    objet: txt(m.objet, 300) || '(sans objet)',
    resume: txt(m.resume, 600),
    dossier_pressenti: txt(m.dossier_pressenti, 200),
    motif_rattachement: txt(m.motif_rattachement, 200),
    certitude: m.certitude === 'sûr' || m.certitude === 'sur' ? 'sûr' : 'incertain',
    reponse_attendue: !!r.attendue,
    reponse_de: adresse(r.de),
    changements: { date_signature: sig, nouveaux_correspondants: liste(ch.nouveaux_correspondants, 20) },
    pieces_jointes: noms(m.pieces_jointes),
    acte_signe_annonce: !!m.acte_signe_annonce,
    signature_proche: !!m.signature_proche
  };
}

// Choix du dossier : renvoie { dossier, motif } ou { dossier: null, motif }
function choisirDossier(m, dossiers, jour) {
  const ouverts = dossiers.filter(d => dossierOuvert(d, jour));
  if (m.certitude !== 'sûr') return { dossier: null, motif: 'rattachement incertain' };
  if (m.dossier_pressenti) {
    const cible = normaliser(m.dossier_pressenti);
    const parNom = ouverts.filter(d => normaliser(d.intitule) === cible || normaliser(nomOutlook(d)) === cible
      || (d.numero && cible.split(' ').includes(normaliser(d.numero))));
    if (parNom.length === 1) return { dossier: parNom[0], motif: 'dossier pressenti' };
    if (parNom.length > 1) return { dossier: null, motif: 'plusieurs dossiers possibles' };
  }
  const ext = adressesExternes(m);
  if (ext.length) {
    const parAdresse = ouverts.filter(d => (d.adresses || []).some(a => ext.includes(a)));
    if (parAdresse.length === 1) return { dossier: parAdresse[0], motif: 'adresse connue' };
    if (parAdresse.length > 1) return { dossier: null, motif: 'adresse liée à plusieurs dossiers' };
  }
  return { dossier: null, motif: m.dossier_pressenti ? 'dossier pressenti inconnu' : 'aucun dossier reconnu' };
}

function jourParis(iso) { return cal.aujourdhui(iso ? new Date(iso) : new Date()); }
function texteMail(m) {
  const qui = m.sens === 'envoyé'
    ? 'Mail envoyé' + (m.destinataires.length ? ' à ' + m.destinataires.slice(0, 3).join(', ') + (m.destinataires.length > 3 ? '…' : '') : '')
    : 'Mail reçu' + (m.expediteur ? ' de ' + m.expediteur : '');
  let t = qui + ' : « ' + m.objet + ' »';
  if (m.resume) t += ' — ' + m.resume;
  if (m.pieces_jointes && m.pieces_jointes.length) t += ' — pièces jointes : ' + m.pieces_jointes.join(', ');
  if (m.reponse_attendue) t += ' — réponse attendue' + (m.reponse_de ? ' de ' + m.reponse_de : '');
  return t.slice(0, 2000);
}

async function rattacher(sql, m, dossierId, motif, apprendre) {
  await sql`UPDATE suivi_mail SET etat = 'rattache', dossier_id = ${dossierId}, motif_etat = ${motif} WHERE id_outlook = ${m.id_outlook}`;
  const deja = await sql`SELECT 1 FROM suivi_evenement WHERE mail_id = ${m.id_outlook} AND dossier_id = ${dossierId} LIMIT 1`;
  if (!deja.length) {
    await sql`INSERT INTO suivi_evenement (dossier_id, nature, texte, date_evt, mail_id)
      VALUES (${dossierId}, 'mail', ${texteMail(m)}, ${jourParis(m.date_mail)}, ${m.id_outlook})`;
  }
  if (apprendre) {
    const nouvelles = adressesExternes(m);
    if (nouvelles.length) await sql`UPDATE suivi_dossier SET adresses = (SELECT array_agg(DISTINCT x) FROM unnest(adresses || ${nouvelles}::text[]) AS x), maj_le = now() WHERE id = ${dossierId}`;
    // bloc « Étude » : les collaborateurs présents dans l'échange (sans relance d'office, JFD coche lui-même)
    const etude = [...new Set([m.expediteur, ...m.destinataires, ...m.copies, ...(m.etude || [])].filter(a => a && types.estEtude(a)))];
    if (etude.length) await sql`UPDATE suivi_dossier SET etude = (SELECT array_agg(DISTINCT x) FROM unnest(etude || ${etude}::text[]) AS x), maj_le = now() WHERE id = ${dossierId}`;
  }
}

// Reprise d'un lot de fiches : [{ drive_id, nom, contenu }] (contenu = objet JSON, ou null si illisible)
async function importer(sql, fiches, jour) {
  const bilan = { fiches: 0, deja: 0, mails: 0, rattaches: 0, a_rattacher: 0, ignores: 0, doublons: 0, erreurs: [] };
  const dossiers = await sql`SELECT id, intitule, partie1, partie2, numero, adresses, etape, classe_le FROM suivi_dossier`;
  const ignores = new Set((await sql`SELECT adresse FROM suivi_expediteur_ignore WHERE fois >= 2`).map(r => r.adresse));
  for (const f of (Array.isArray(fiches) ? fiches : []).slice(0, 20)) {
    const driveId = txt(f && f.drive_id, 200);
    if (!driveId) continue;
    const c = f.contenu && typeof f.contenu === 'object' ? f.contenu : null;
    const mails = c && Array.isArray(c.mails) ? c.mails.slice(0, MAX_MAILS).map(mailDeFiche).filter(Boolean) : [];
    const statut = !c ? 'illisible' : (c.statut === 'erreur' || c.erreur) ? 'erreur' : 'ok';
    const periode = c && c.periode && typeof c.periode === 'object' ? c.periode : {};
    const ins = await sql`INSERT INTO suivi_releve (drive_id, nom, releve_le, periode_du, periode_au, statut, erreur, nb_mails)
      VALUES (${driveId}, ${txt(f.nom, 200)}, ${c ? instant(c.releve_le) : null}, ${instant(periode.du)}, ${instant(periode.au)}, ${statut},
              ${c && c.erreur ? txt(typeof c.erreur === 'string' ? c.erreur : JSON.stringify(c.erreur), 500) : (c ? null : 'fiche illisible')}, ${mails.length})
      ON CONFLICT (drive_id) DO NOTHING RETURNING drive_id`;
    if (!ins.length) { bilan.deja++; continue; }
    bilan.fiches++;
    if (statut !== 'ok') bilan.erreurs.push((txt(f.nom, 200) || driveId) + (c && c.erreur ? ' : ' + txt(String(c.erreur), 200) : ' : fiche illisible'));
    for (const m of mails) {
      const sortieIgnoree = m.sens === 'reçu' && m.expediteur && ignores.has(m.expediteur);
      const choix = sortieIgnoree ? { dossier: null, motif: 'expéditeur ignoré' } : choisirDossier(m, dossiers, jour);
      const etat = sortieIgnoree ? 'ignore' : choix.dossier ? 'rattache' : 'a_rattacher';
      const r = await sql`INSERT INTO suivi_mail (id_outlook, releve, dossier_id, etat, motif_etat, sens, date_mail, expediteur, destinataires, copies, etude,
          objet, resume, dossier_pressenti, motif_rattachement, certitude, reponse_attendue, reponse_de, changements, pieces_jointes, acte_signe_annonce, signature_proche)
        VALUES (${m.id_outlook}, ${driveId}, ${null}, ${etat === 'rattache' ? 'a_rattacher' : etat}, ${choix.motif}, ${m.sens}, ${m.date_mail}, ${m.expediteur},
          ${m.destinataires}, ${m.copies}, ${m.etude}, ${m.objet}, ${m.resume}, ${m.dossier_pressenti}, ${m.motif_rattachement}, ${m.certitude},
          ${m.reponse_attendue}, ${m.reponse_de}, ${JSON.stringify(m.changements)}, ${m.pieces_jointes}, ${m.acte_signe_annonce}, ${m.signature_proche})
        ON CONFLICT (id_outlook) DO NOTHING RETURNING id_outlook`;
      if (!r.length) { bilan.doublons++; continue; }
      bilan.mails++;
      if (etat === 'rattache') { await rattacher(sql, m, choix.dossier.id, choix.motif, false); bilan.rattaches++; }
      else if (etat === 'ignore') bilan.ignores++;
      else bilan.a_rattacher++;
    }
  }
  return bilan;
}

function versMail(r) {
  const x = { ...r };
  if (x.date_mail instanceof Date) x.date_mail = x.date_mail.toISOString();
  if (x.cree_le instanceof Date) x.cree_le = x.cree_le.toISOString();
  return x;
}
async function aRattacher(sql) {
  return (await sql`SELECT * FROM suivi_mail WHERE etat = 'a_rattacher' ORDER BY date_mail DESC NULLS LAST, cree_le DESC LIMIT 200`).map(versMail);
}
async function rattacherMain(sql, idOutlook, dossierId) {
  const [m] = await sql`SELECT * FROM suivi_mail WHERE id_outlook = ${idOutlook}`;
  if (!m) return { erreur: 'Mail introuvable.' };
  const [d] = await sql`SELECT id FROM suivi_dossier WHERE id = ${dossierId}`;
  if (!d) return { erreur: 'Dossier introuvable.' };
  await rattacher(sql, versMail(m), dossierId, 'rattaché à la main', true);
  return { ok: true };
}
async function ignorer(sql, idOutlook) {
  const [m] = await sql`UPDATE suivi_mail SET etat = 'ignore', motif_etat = 'ignoré à la main' WHERE id_outlook = ${idOutlook} RETURNING *`;
  if (!m) return { erreur: 'Mail introuvable.' };
  let fois = 0;
  if (m.sens === 'reçu' && m.expediteur && !estEtude(m.expediteur)) {
    const [r] = await sql`INSERT INTO suivi_expediteur_ignore (adresse) VALUES (${m.expediteur})
      ON CONFLICT (adresse) DO UPDATE SET fois = suivi_expediteur_ignore.fois + 1, maj_le = now() RETURNING fois`;
    fois = r.fois;
  }
  return { ok: true, expediteur: m.expediteur, fois };
}

/* Relevés manqués : on parcourt les créneaux attendus des 48 dernières heures, du plus récent au plus ancien,
   et l'on compte les créneaux sans fiche d'affilée. Un créneau n'est jugé que 45 minutes après son début
   (une tâche peut partir avec un peu de retard). Rien n'est compté avant la toute première fiche reçue. */
function heureParis(t) {
  const p = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hourCycle: 'h23' }).format(t);
  return +p.replace(/\D/g, '');
}
function creneauxAttendus(maintenant, heures) {
  const l = [];
  const base = Math.floor(maintenant.getTime() / 3600000) * 3600000;
  for (let i = 0; i < (heures || 48); i++) {
    const debut = new Date(base - i * 3600000);
    if (maintenant.getTime() < debut.getTime() + 45 * 60000) continue;
    const jour = cal.aujourdhui(debut), h = heureParis(debut);
    if ((cal.estOuvre(jour) ? HEURES_OUVRE : HEURES_CHOME).includes(h)) l.push({ debut: debut, jour: jour, heure: h });
  }
  return l; // du plus récent au plus ancien
}
function manquesDAffilee(maintenant, releves) {
  const temps = releves.map(r => new Date(r).getTime()).filter(x => !isNaN(x));
  if (!temps.length) return { manques: 0, dernier: null };
  const premier = Math.min(...temps), dernier = Math.max(...temps);
  let n = 0;
  for (const c of creneauxAttendus(maintenant)) {
    const a = c.debut.getTime();
    if (a + 3600000 <= premier) break;
    if (temps.some(t => t >= a && t < a + 3600000)) break;
    n++;
  }
  return { manques: n, dernier: new Date(dernier).toISOString() };
}
async function etatReleves(sql, maintenant) {
  const rows = await sql`SELECT releve_le FROM suivi_releve WHERE releve_le IS NOT NULL AND releve_le > now() - interval '3 days'`;
  const e = manquesDAffilee(maintenant || new Date(), rows.map(r => r.releve_le));
  const [n] = await sql`SELECT count(*)::int AS n FROM suivi_mail WHERE etat = 'a_rattacher'`;
  const erreurs = await sql`SELECT nom, erreur, releve_le FROM suivi_releve WHERE statut <> 'ok' AND repris_le > now() - interval '2 days' ORDER BY repris_le DESC LIMIT 5`;
  return { manques: e.manques, dernier: e.dernier, a_rattacher: n.n, erreurs: erreurs.map(r => ({ nom: r.nom, erreur: r.erreur })) };
}
// Journal commun des incidents (table « incident » de MORNING, même base) : jamais bloquant
async function signalerManques(sql, etat) {
  try {
    const ouverts = await sql`SELECT id FROM incident WHERE outil = 'SUIVI' AND detail LIKE 'Relevés des mails%' AND clos_le IS NULL`;
    if (etat.manques >= SEUIL_MANQUES) {
      const detail = 'Relevés des mails manqués : ' + etat.manques + ' d’affilée' + (etat.dernier ? ' (dernière fiche reçue le ' + new Date(etat.dernier).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', dateStyle: 'short', timeStyle: 'short' }) + ')' : '');
      if (ouverts.length) await sql`UPDATE incident SET dernier_vu_le = now(), detail = ${detail} WHERE id = ${ouverts[0].id}`;
      else await sql`INSERT INTO incident (outil, nature, detail) VALUES ('SUIVI', 'service', ${detail})`;
    } else if (ouverts.length) {
      await sql`UPDATE incident SET clos_le = now() WHERE outil = 'SUIVI' AND detail LIKE 'Relevés des mails%' AND clos_le IS NULL`;
    }
  } catch (e) { console.error('SUIVI incident', e.message); }
}

module.exports = {
  normaliser, mailDeFiche, choisirDossier, texteMail, importer, aRattacher, rattacherMain, ignorer,
  creneauxAttendus, manquesDAffilee, etatReleves, signalerManques, SEUIL_MANQUES
};
