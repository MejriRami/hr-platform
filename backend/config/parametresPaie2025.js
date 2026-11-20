'use strict';

/**
 * Statutory / conventional parameters for payroll year 2025 (Tunisia /
 * CARTHAGE TUNISIE SERVICES). Ported from the Python MVP's
 * backend/config/parametres_2025.yaml — same values, same confidence
 * levels. Loaded once at startup and passed as an argument into the
 * calculation services (services/paie/*.js) — no globals, no statutory
 * number hardcoded in calculation code.
 */

const Decimal = require('decimal.js');

function loadParametresPaie2025() {
  return {
    // CNSS salarié — régime général non agricole, pas de plafond de
    // cotisation. CONFIRMED 2026-07-29 by reverse-engineering 27 real
    // July 2026 payslips (CARTHAGE TUNISIE SERVICES / SAHEL) — cnss_retenue /
    // brut = exactly 0.0968 on every single one, to 3 decimals, no
    // exceptions. See tests/paie/realPayslips.test.js.
    tauxCnssSalarie: new Decimal('0.0968'),

    // CSS — contribution sociale de solidarité. CONFIRMED 2026-07-29 from
    // the same real payslips: css matches (net_imposable - abattement) x
    // 0.005 to within ~0.06 TND/month on all 27 samples (residual likely
    // just intermediate rounding in the source system). Applied to
    // net_imposable AFTER abattement, not to the raw "Salaire Imposable"
    // figure printed on the bulletin.
    // RE-CONFIRMED 2026-09-14 against 26 real August 2026 payslips
    // (including several chef-de-famille / multi-enfant employees this
    // time): CSS matches (net_imposable - abattement) x 0.005 with NO
    // dependency on family status -- déductions familiales must NOT be
    // subtracted before computing CSS (an earlier version of this code
    // did subtract them; that was wrong -- fixed in
    // services/paie/paie.js). See tests/paie/augustPayslips2026.test.js.
    tauxCss: new Decimal('0.005'),

    // Plafond annuel de l'abattement forfaitaire pour frais professionnels
    // (le calcul mensuel divise cette valeur par 12). Loosely CONFIRMED
    // 2026-07-29: fits the real payslip CSS figures to within ~0.06
    // TND/month — close enough that 2000/an is very likely correct, but
    // there is a small unresolved residual (~1846/an would fit marginally
    // better). For CSS it is applied monthly (/12); for IRPP it is applied
    // once to the annualised base (see irppMensuelCumule).
    plafondAbattement: new Decimal('2000'),

    // Taux de l'abattement forfaitaire pour frais professionnels, appliqué
    // à (brut - cnss_salarie), plafonné par plafondAbattement / 12.
    // CONFIRMED 2026-07-29: for real employees whose 10% falls below the
    // plafond (so the cap doesn't bind), the real CSS matches a 10% rate
    // almost exactly (diff < 0.03 TND/month).
    tauxAbattementForfaitaire: new Decimal('0.10'),

    // Barème IRPP 2026, sur une base ANNUELLE (TND). Les tranches sont
    // évaluées en cascade (plancher inclus, plafond exclu ; la dernière
    // tranche n'a pas de plafond -> null). Équivalent exact de la forme
    // "base x taux - montant à retrancher" (0 / 750 / 1750 / 2750 / 3650 /
    // 4850 / 5850 / 7250).
    // the developer's 2026-10 instruction: use the official barème, replacing the
    // older 0/26/28/32/35/40 table that had been fitted to July/August 2026
    // payslips with an invented 200/month personal deduction (both dropped
    // -- see tests/paie/augustPayslips2026.test.js history).
    baremeIrpp: [
      { plancher: new Decimal('0'), plafond: new Decimal('5000'), taux: new Decimal('0.00') },
      { plancher: new Decimal('5000'), plafond: new Decimal('10000'), taux: new Decimal('0.15') },
      { plancher: new Decimal('10000'), plafond: new Decimal('20000'), taux: new Decimal('0.25') },
      { plancher: new Decimal('20000'), plafond: new Decimal('30000'), taux: new Decimal('0.30') },
      { plancher: new Decimal('30000'), plafond: new Decimal('40000'), taux: new Decimal('0.33') },
      { plancher: new Decimal('40000'), plafond: new Decimal('50000'), taux: new Decimal('0.36') },
      { plancher: new Decimal('50000'), plafond: new Decimal('70000'), taux: new Decimal('0.38') },
      { plancher: new Decimal('70000'), plafond: null, taux: new Decimal('0.40') },
    ],

    // Monthly taxable salary is annualised over the 12 monthly payslips
    // before applying baremeIrpp (cumulative method, see irppMensuelCumule
    // in services/paie/irpp.js). The annual gratification is NOT included
    // here: it varies per employee (note, hours), so its IRPP is taken on
    // its own payslip by the difference method instead -- see
    // services/paie/gratification.js. the developer's choice, 2026-10 (13 was tried
    // first: same yearly total only when the bonus is exactly one month).
    coefficientAnnualisation: 12,

    // Déductions pour situation et charges de famille (code IRPP art. 40),
    // base ANNUELLE (TND), subtracted from the annualised base before
    // baremeIrpp. maxEnfants caps ordinary + student children together;
    // handicapped children are not capped. Parents à charge are NOT
    // handled in payroll (annual declaration only).
    deductionsFamiliales: {
      chefDeFamille: new Decimal('300'),
      parEnfant: new Decimal('100'),
      parEnfantEtudiant: new Decimal('1000'),
      parEnfantHandicape: new Decimal('2000'),
      maxEnfants: 4,
    },

    // Prime d'ancienneté — REMOVED 2026-07-29. None of 40 real July 2026
    // payslips (CARTHAGE TUNISIE SERVICES / SAHEL) show a separate "prime
    // d'ancienneté" line, including employees with 5-11 years of tenure.
    // Confirmed with the user this company does not pay it as a distinct
    // line, so it was dropped from the CDI brut formula entirely.
  };
}

let cached = null;
function getParametresPaie2025() {
  if (!cached) cached = loadParametresPaie2025();
  return cached;
}

module.exports = { loadParametresPaie2025, getParametresPaie2025 };
