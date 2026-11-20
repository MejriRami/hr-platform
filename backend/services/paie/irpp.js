'use strict';

const Decimal = require('decimal.js');

/**
 * IRPP — barème progressif annuel, déductions familiales annuelles, et
 * retenue mensuelle cumulative. All functions are pure and take the
 * configured barème/déductions as arguments — no statutory number is
 * hardcoded here.
 */

/** Progressive tax on an annual base. Brackets are [plancher, plafond). */
function baremeProgressif(baseAnnuelle, bareme) {
  if (baseAnnuelle.lte(0)) return new Decimal(0);
  let total = new Decimal(0);
  for (const tranche of bareme) {
    if (baseAnnuelle.lte(tranche.plancher)) break;
    const haut = tranche.plafond === null ? baseAnnuelle : Decimal.min(baseAnnuelle, tranche.plafond);
    total = total.plus(haut.minus(tranche.plancher).times(tranche.taux));
  }
  return total;
}

/**
 * Annual familial deduction (code IRPP art. 40), subtracted from the
 * annualised base. nbEnfants is the TOTAL number of dependent children;
 * nbEnfantsEtudiants / nbEnfantsHandicapes are subsets of it. Students
 * and ordinary children share the maxEnfants cap (students counted
 * first, as the more valuable deduction); handicapped children are
 * uncapped.
 */
function deductionsFamiliales(chefFamille, enfants, config) {
  const nbHandicapes = Math.max(0, enfants.nbEnfantsHandicapes || 0);
  const nbEtudiants = Math.max(0, enfants.nbEnfantsEtudiants || 0);
  const nbOrdinaires = Math.max(0, (enfants.nbEnfants || 0) - nbEtudiants - nbHandicapes);

  const etudiantsRetenus = Math.min(nbEtudiants, config.maxEnfants);
  const ordinairesRetenus = Math.min(nbOrdinaires, config.maxEnfants - etudiantsRetenus);

  let total = new Decimal(0);
  if (chefFamille) total = total.plus(config.chefDeFamille);
  total = total.plus(config.parEnfant.times(ordinairesRetenus));
  total = total.plus(config.parEnfantEtudiant.times(etudiantsRetenus));
  total = total.plus(config.parEnfantHandicape.times(nbHandicapes));
  return total;
}

/**
 * Annual IRPP on an annual taxable salary income (brut - CNSS):
 * frais professionnels (10%, capped at plafondAbattement), déductions
 * familiales, base rounded UP to the dinar, then the barème.
 */
function impotAnnuelSurRevenu(revenuAnnuel, deductionsFamilialesAnnuelles, params) {
  const fraisProfessionnels = Decimal.min(
    revenuAnnuel.times(params.tauxAbattementForfaitaire),
    params.plafondAbattement
  );
  const baseAnnuelle = Decimal.max(0, revenuAnnuel.minus(fraisProfessionnels).minus(deductionsFamilialesAnnuelles))
    .toDecimalPlaces(0, Decimal.ROUND_CEIL);
  const impotAnnuel = baremeProgressif(baseAnnuelle, params.baremeIrpp);
  return { fraisProfessionnels, baseAnnuelle, impotAnnuel };
}

/**
 * Monthly IRPP withholding, cumulative method (the developer's whiteboard, 2026-10):
 *
 *   R      = siMensuel x coefficientAnnualisation (12 -- the annual
 *            gratification is taxed separately, see gratification.js)
 *   F      = min(R x 10%, plafondAbattement)
 *   B      = ceil(max(0, R - F - deductionsFamilialesAnnuelles))
 *   impot  = baremeProgressif(B)
 *   IRPP_m = (impot - IRPP already withheld this year) / (12 - mois + 1)
 *
 * so January spreads the annual tax over 12, February subtracts January's
 * withholding and spreads the rest over 11, ..., December settles the
 * balance. Months earlier this year with no known withholding (before the
 * app's first import, or not employed/imported that month) are counted in
 * moisSansHistorique and assumed to have withheld impot / 12 each -- so a
 * stable salary always gives impot / 12 regardless of history.
 *
 * Never negative: an over-withholding (salary drop) is not refunded on
 * the payslip, the monthly figure just falls to 0.
 *
 * siMensuel: brut - CNSS salarié for this month.
 * mois: 1..12. irppDejaRetenu: sum of this year's actual withholdings for
 * months before `mois`.
 */
function irppMensuelCumule({
  siMensuel,
  mois,
  irppDejaRetenu,
  moisSansHistorique = 0,
  deductionsFamilialesAnnuelles,
  params,
}) {
  const revenuAnnuel = siMensuel.times(params.coefficientAnnualisation);
  const { fraisProfessionnels, baseAnnuelle, impotAnnuel } =
    impotAnnuelSurRevenu(revenuAnnuel, deductionsFamilialesAnnuelles, params);

  const retenuTotal = irppDejaRetenu.plus(impotAnnuel.dividedBy(12).times(moisSansHistorique));
  const moisRestants = 12 - mois + 1;
  const irpp = Decimal.max(0, impotAnnuel.minus(retenuTotal).dividedBy(moisRestants));

  return { revenuAnnuel, fraisProfessionnels, baseAnnuelle, impotAnnuel, retenuTotal, moisRestants, irpp };
}

/**
 * IRPP on an employee's LAST payslip (solde de tout compte): settles the
 * year instead of projecting it -- the annual tax on what was actually
 * earned this year (months already paid + this final month, which carries
 * the leave payout and prorated gratification), minus everything already
 * withheld. Can be NEGATIVE: an over-withholding is refunded on the final
 * payslip, since there is no later month to absorb it.
 *
 * siDejaPercu / irppDejaRetenu: actual figures for the months known to the
 * app. moisSansHistorique: months worked this year before the app's first
 * import, assumed paid at siMensuelEstime and withheld at the matching
 * stable monthly IRPP (same assumption as irppMensuelCumule).
 */
function irppRegularisationDepart({
  siMois,
  siDejaPercu,
  irppDejaRetenu,
  moisSansHistorique = 0,
  siMensuelEstime,
  deductionsFamilialesAnnuelles,
  params,
}) {
  const impotMensuelEstime = moisSansHistorique > 0
    ? impotAnnuelSurRevenu(
      siMensuelEstime.times(params.coefficientAnnualisation),
      deductionsFamilialesAnnuelles,
      params
    ).impotAnnuel.dividedBy(12)
    : new Decimal(0);

  const revenuAnnuel = siDejaPercu.plus(siMensuelEstime.times(moisSansHistorique)).plus(siMois);
  const retenuTotal = irppDejaRetenu.plus(impotMensuelEstime.times(moisSansHistorique));
  const { fraisProfessionnels, baseAnnuelle, impotAnnuel } =
    impotAnnuelSurRevenu(revenuAnnuel, deductionsFamilialesAnnuelles, params);

  return {
    revenuAnnuel,
    fraisProfessionnels,
    baseAnnuelle,
    impotAnnuel,
    retenuTotal,
    moisRestants: 1,
    irpp: impotAnnuel.minus(retenuTotal),
  };
}

module.exports = {
  baremeProgressif,
  deductionsFamiliales,
  impotAnnuelSurRevenu,
  irppMensuelCumule,
  irppRegularisationDepart,
};
