'use strict';

/** CSS — contribution sociale de solidarité, assise sur le net imposable. */

function css(netImposable, tauxCss) {
  return netImposable.times(tauxCss);
}

module.exports = { css };
