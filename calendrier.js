/* SUIVI — calendrier commun (page et fonction serveur).
   Jours ouvrés = hors samedis, dimanches, jours fériés français et solennités catholiques retenues.
   Toutes les dates sont des chaînes « AAAA-MM-JJ » (aucune heure, aucun fuseau). */
(function (racine) {
  'use strict';

  function versDate(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function versChaine(d) { return d.toISOString().slice(0, 10); }
  function decaler(s, n) { var d = versDate(s); d.setUTCDate(d.getUTCDate() + n); return versChaine(d); }
  function jourSemaine(s) { return versDate(s).getUTCDay(); } // 0 = dimanche

  // Date de Pâques (algorithme de Meeus, calendrier grégorien)
  function paques(annee) {
    var a = annee % 19, b = Math.floor(annee / 100), c = annee % 100, d = Math.floor(b / 4), e = b % 4,
        f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30,
        i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7,
        m = Math.floor((a + 11 * h + 22 * l) / 451), mois = Math.floor((h + l - 7 * m + 114) / 31),
        jour = ((h + l - 7 * m + 114) % 31) + 1;
    return annee + '-' + String(mois).padStart(2, '0') + '-' + String(jour).padStart(2, '0');
  }

  var cache = {};
  // Liste des jours chômés d'une année : { 'AAAA-MM-JJ': { nom, ferie, solennite, couleur? } }
  function joursChomes(annee) {
    if (cache[annee]) return cache[annee];
    var P = paques(annee), t = {};
    function pose(date, nom, ferie, solennite, couleur) {
      var x = t[date];
      if (x) { // un jour à la fois férié et solennité : on garde le nom liturgique
        x.ferie = x.ferie || ferie; x.solennite = x.solennite || solennite;
        if (solennite) { x.nom = nom; x.couleur = couleur || x.couleur; }
        return;
      }
      t[date] = { nom: nom, ferie: ferie, solennite: solennite, couleur: couleur || null };
    }
    function f(mmjj) { return annee + '-' + mmjj; }
    // Jours fériés civils
    pose(f('01-01'), 'Jour de l’An', true, false);
    pose(decaler(P, 1), 'Lundi de Pâques', true, false);
    pose(f('05-01'), 'Fête du Travail', true, false);
    pose(f('05-08'), 'Victoire 1945', true, false);
    pose(decaler(P, 39), 'Ascension', true, false);
    pose(decaler(P, 50), 'Lundi de Pentecôte', true, false);
    pose(f('07-14'), 'Fête nationale', true, false);
    pose(f('08-15'), 'Assomption', true, false);
    pose(f('11-01'), 'Toussaint', true, false);
    pose(f('11-11'), 'Armistice 1918', true, false);
    pose(f('12-25'), 'Noël', true, false);
    // Solennités (à leur date propre, sans report)
    pose(f('01-01'), 'Sainte Marie, Mère de Dieu', false, true, 'blanc');
    pose(f('01-06'), 'Épiphanie', false, true, 'blanc');
    pose(f('03-19'), 'Saint Joseph', false, true, 'blanc');
    pose(f('03-25'), 'Annonciation', false, true, 'blanc');
    pose(decaler(P, 39), 'Ascension', false, true, 'blanc');
    pose(decaler(P, 60), 'Fête-Dieu', false, true, 'blanc');
    pose(decaler(P, 68), 'Sacré-Cœur', false, true, 'blanc');
    pose(f('06-24'), 'Nativité de saint Jean-Baptiste', false, true, 'blanc');
    pose(f('06-29'), 'Saints Pierre et Paul', false, true, 'rouge');
    pose(f('08-15'), 'Assomption', false, true, 'blanc');
    pose(f('11-01'), 'Toussaint', false, true, 'blanc');
    pose(f('12-08'), 'Immaculée Conception', false, true, 'blanc');
    pose(f('12-25'), 'Noël', false, true, 'blanc');
    cache[annee] = t;
    return t;
  }

  // Couleur du temps liturgique (pour les fériés civils et par défaut)
  function couleurDuTemps(s) {
    var annee = +s.slice(0, 4), P = paques(annee);
    var noel = annee + '-12-25', d24 = versDate(annee + '-12-24');
    var avent = versChaine(new Date(d24.getTime() - ((d24.getUTCDay() || 7) + 21) * 86400000));
    if (s >= avent && s < noel) return 'violet';
    if (s >= noel || s <= annee + '-01-13') return 'blanc';
    if (s >= decaler(P, -46) && s < decaler(P, -3)) return 'violet';
    if (s >= P && s < decaler(P, 49)) return 'blanc';
    if (s === decaler(P, 49)) return 'rouge';
    return 'vert';
  }

  function infoJour(s) {
    var c = joursChomes(+s.slice(0, 4))[s] || null;
    if (!c) return null;
    return { date: s, nom: c.nom, ferie: c.ferie, solennite: c.solennite, couleur: c.couleur || couleurDuTemps(s) };
  }

  function estOuvre(s) {
    var j = jourSemaine(s);
    return j !== 0 && j !== 6 && !joursChomes(+s.slice(0, 4))[s];
  }

  function ajouterJoursOuvres(s, n) {
    var d = s, compte = 0;
    while (compte < n) { d = decaler(d, 1); if (estOuvre(d)) compte++; }
    return d;
  }

  // Date du jour à Paris, au format AAAA-MM-JJ
  function aujourdhui(maintenant) {
    var x = maintenant || new Date();
    return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(x);
  }

  var api = {
    paques: paques, decaler: decaler, infoJour: infoJour, estOuvre: estOuvre,
    ajouterJoursOuvres: ajouterJoursOuvres, couleurDuTemps: couleurDuTemps, aujourdhui: aujourdhui
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else racine.SuiviCalendrier = api;
})(this);
