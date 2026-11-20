'use strict';

/** CNSS salarié — régime général non agricole, pas de plafond. */

function cnssSalarie(brut, tauxCnssSalarie) {
  return brut.times(tauxCnssSalarie);
}

module.exports = { cnssSalarie };
