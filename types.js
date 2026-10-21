/* SUIVI — types de dossier et délais moyens (page et fonction serveur).
   Arbitrage du 20/10/2026 : l'anneau est découpé par TYPE ; chaque type porte
   une nuance de la couleur de sa matière ; le bord extérieur de son secteur
   correspond à sa durée moyenne de traitement.
   Toutes les dates sont des chaînes « AAAA-MM-JJ ». */
(function (racine) {
  'use strict';

  /* ordre des matières autour de l'anneau, dans le sens des aiguilles d'une montre depuis le haut */
  var MATIERES = [
    { id: 'immobilier', nom: 'Immobilier', couleur: '#33838B' },
    { id: 'affaires', nom: 'Affaires', couleur: '#FFC900' },
    { id: 'international', nom: 'International', couleur: '#B9CCEA' },
    { id: 'famille', nom: 'Famille', couleur: '#6DD5DC' }
  ];

  /* delai : durée moyenne en jours ; mois : durée en mois (succession) ;
     ajustable : le délai se règle sur la fiche ; depuis : point de départ du délai */
  var TYPES = [
    { id: 'imm_vente', matiere: 'immobilier', nom: 'Vente', court: 'VENTE', delai: 90, couleur: '#33838B' },
    { id: 'imm_audit', matiere: 'immobilier', nom: 'Audit', court: 'AUDIT', delai: 40, ajustable: true, couleur: '#5FB0B7' },
    { id: 'imm_autre', matiere: 'immobilier', nom: 'Autre (immobilier)', court: 'IMMO · AUTRE', delai: 60, ajustable: true, couleur: '#226068' },
    { id: 'aff_societe', matiere: 'affaires', nom: 'Société', court: 'SOCIÉTÉ', delai: 60, couleur: '#FFC900' },
    { id: 'aff_autre', matiere: 'affaires', nom: 'Autre (affaires)', court: 'AFFAIRES · AUTRE', delai: 60, ajustable: true, couleur: '#FFE27A' },
    { id: 'int_legalisation', matiere: 'international', nom: 'Légalisation', court: 'LÉGALISATION', delai: 20, couleur: '#B9CCEA' },
    { id: 'int_autre', matiere: 'international', nom: 'Autre (international)', court: 'INTERNAT. · AUTRE', delai: 20, ajustable: true, couleur: '#86A3D3' },
    { id: 'fam_succession', matiere: 'famille', nom: 'Succession', court: 'SUCCESSION', mois: 6, depuis: 'deces', couleur: '#6DD5DC' },
    { id: 'fam_donation', matiere: 'famille', nom: 'Donation', court: 'DONATION', delai: 50, couleur: '#A9E9ED' },
    { id: 'fam_divorce', matiere: 'famille', nom: 'Divorce', court: 'DIVORCE', delai: 183, ajustable: true, couleur: '#3FB0B9' },
    { id: 'fam_regime', matiere: 'famille', nom: 'Régime matrimonial', court: 'RÉGIME MATRIM.', delai: 50, couleur: '#2C8C94' },
    { id: 'fam_autre', matiere: 'famille', nom: 'Autre (famille)', court: 'FAMILLE · AUTRE', delai: 60, ajustable: true, couleur: '#CFF3F5' }
  ];
  var PAR_ID = {}; TYPES.forEach(function (t) { PAR_ID[t.id] = t; });
  var DEFAUT = 'imm_autre';

  function type(id) { return PAR_ID[id] || PAR_ID[DEFAUT]; }
  function matiere(id) { for (var i = 0; i < MATIERES.length; i++) if (MATIERES[i].id === id) return MATIERES[i]; return MATIERES[0]; }

  function versDate(s) { var p = s.split('-'); return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); }
  function versChaine(d) { return d.toISOString().slice(0, 10); }
  function jours(a, b) { return Math.round((versDate(b) - versDate(a)) / 86400000); }
  function decaler(s, n) { var d = versDate(s); d.setUTCDate(d.getUTCDate() + n); return versChaine(d); }
  /* ajoute des mois en restant dans le mois visé (31 août + 6 mois = 28 ou 29 février) */
  function ajouterMois(s, n) {
    var p = s.split('-'), a = +p[0], m = +p[1] - 1 + n, j = +p[2];
    a += Math.floor(m / 12); m = ((m % 12) + 12) % 12;
    var dernier = new Date(Date.UTC(a, m + 1, 0)).getUTCDate();
    return versChaine(new Date(Date.UTC(a, m, Math.min(j, dernier))));
  }

  /* Point de départ, fin prévue et avancement d'un dossier.
     d : { type_dossier, date_ouverture, date_deces, delai_jours } */
  function delais(d, aujourdhui) {
    var t = type(d.type_dossier);
    var depart = (t.depuis === 'deces' && d.date_deces) || d.date_ouverture || aujourdhui;
    var fin;
    if (t.mois) fin = ajouterMois(depart, t.mois);
    else fin = decaler(depart, (t.ajustable && d.delai_jours > 0) ? d.delai_jours : t.delai);
    var reportee = false;
    if (d.date_limite) { fin = d.date_limite; reportee = true; }   /* date limite réajustée à la main (21/10/2026) */
    var duree = Math.max(1, jours(depart, fin));
    var ecoule = Math.max(0, jours(depart, aujourdhui));
    return {
      type: t, depart: depart, fin: fin, duree: duree, ecoule: ecoule,
      part: ecoule / duree,                       /* 0 au départ, 1 au délai moyen */
      reste: jours(aujourdhui, fin), reportee: reportee,
      decesManquant: t.depuis === 'deces' && !d.date_deces
    };
  }
  /* Sablier (21/10/2026) : il apparaît 3 jours avant la date limite, puis clignote une fois
     la date passée ; rien pour un dossier signé, abandonné ou clos. */
  function sablier(d, aujourdhui) {
    if (d.signature_le || d.etape === 'abandonne' || d.etape === 'clos' || d.etape === 'formalites') return null;
    var x = delais(d, aujourdhui);
    if (x.reste < 0) return 'depasse';
    if (x.reste <= 3) return 'proche';
    return null;
  }
  function delaiParDefaut(id) { var t = type(id); return t.mois ? null : t.delai; }

  /* Type deviné à partir de l'objet du mail (simple proposition, corrigeable) */
  function deviner(texte) {
    var s = (texte || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/\bsuccession|\bdeces\b|\bdevolution|\bnotoriete\b/.test(s)) return 'fam_succession';
    if (/\bdonation|\bdonation-partage/.test(s)) return 'fam_donation';
    if (/\bdivorce|\bliquidation du regime/.test(s)) return 'fam_divorce';
    if (/\bregime matrimonial|\bchangement de regime|\bcontrat de mariage|\bpacs\b/.test(s)) return 'fam_regime';
    if (/\blegalisation|\bapostille/.test(s)) return 'int_legalisation';
    if (/\baudit\b/.test(s)) return 'imm_audit';
    if (/\bsociete|\bstatuts|\bcession de parts|\bcession d'actions|\bconstitution|\bsci\b|\bsas\b|\bsarl\b|\bfusion|\btup\b/.test(s)) return 'aff_societe';
    if (/\bvente|\bpromesse|\bcompromis|\bacquisition|\breiteration|\bacte authentique/.test(s)) return 'imm_vente';
    return null;
  }

  var api = {
    MATIERES: MATIERES, TYPES: TYPES, DEFAUT: DEFAUT,
    type: type, matiere: matiere, delais: delais, sablier: sablier, delaiParDefaut: delaiParDefaut,
    deviner: deviner, ajouterMois: ajouterMois, jours: jours
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else racine.SuiviTypes = api;
})(this);
