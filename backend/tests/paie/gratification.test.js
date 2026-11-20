'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Decimal = require('decimal.js');

const { calculerPrimeGratification } = require('../../services/paie/gratification');

/**
 * Synthetic, clean-number parameters -- same convention as
 * tests/paie/calculation.test.js: deliberately NOT the real seeded
 * parametresPaie2025.js values, so these tests keep passing even if the
 * placeholder statutory rates are swapped out for verified ones.
 */
function makeParams() {
  return {
    tauxCnssSalarie: new Decimal('0.10'),
    tauxCss: new Decimal('0.02'),
    plafondAbattement: new Decimal('1200'),
    tauxAbattementForfaitaire: new Decimal('0.10'),
    coefficientAnnualisation: 12,
    baremeIrpp: [
      { plancher: new Decimal('0'), plafond: new Decimal('6000'), taux: new Decimal('0.00') },
      { plancher: new Decimal('6000'), plafond: new Decimal('12000'), taux: new Decimal('0.20') },
      { plancher: new Decimal('12000'), plafond: new Decimal('24000'), taux: new Decimal('0.25') },
      { plancher: new Decimal('24000'), plafond: null, taux: new Decimal('0.30') },
    ],
  };
}

function d(v) {
  return new Decimal(v);
}

function makeInput(overrides = {}) {
  return {
    salaireBrutTheorique: d('1000'),
    note: d('20'),
    heuresTravaillees: d('176'),
    heuresTheoriques: d('176'),
    nbMoisPayes: d('12'),
    ...overrides,
  };
}

test('full note, full presence, full year -> prime equals salaireBrutTheorique before tax', () => {
  const { detail } = calculerPrimeGratification(makeInput(), makeParams());
  assert.ok(detail.prime.equals(d('1000.000')));
});

test('prime is taxed at the marginal rate on top of the 12 salaries (difference method)', () => {
  const { detail, netAPayer } = calculerPrimeGratification(makeInput(), makeParams());

  // salaries alone: R = 900 x 12 = 10800, F = 1080, B = 9720 -> impot 744
  // + prime (SI 900): R = 11700, F = 1170, B = 10530 -> impot 906
  // -> IRPP on the prime = 162 (900 - its 90 abattement, x 20%), not 0
  assert.ok(detail.cnss.equals(d('100.000')));
  assert.ok(detail.impotAnnuelSansPrime.equals(d('744.000')));
  assert.ok(detail.impotAnnuelAvecPrime.equals(d('906.000')));
  assert.ok(detail.abattement.equals(d('90.000')));
  assert.ok(detail.netImposable.equals(d('810.000')));
  assert.ok(detail.css.equals(d('16.200')));
  assert.ok(detail.irpp.equals(d('162.000')));
  assert.ok(netAPayer.equals(d('721.800'))); // 1000 - 100 - 162 - 16.2
});

test('family deduction lowers both sides, prime still taxed at the marginal rate', () => {
  const input = makeInput({ deductionsFamilialesAnnuelles: d('4000') });
  const { detail } = calculerPrimeGratification(input, makeParams());
  // salaries alone: B = 9720 - 4000 = 5720 (0% bracket) -> 0
  // + prime: B = 10530 - 4000 = 6530 -> 530 x 20% = 106
  assert.ok(detail.impotAnnuelSansPrime.equals(d('0.000')));
  assert.ok(detail.irpp.equals(d('106.000')));
});

test('larger prime crosses into the second IRPP bracket', () => {
  const input = makeInput({ salaireBrutTheorique: d('10000') });
  const { detail, netAPayer } = calculerPrimeGratification(input, makeParams());

  assert.ok(detail.prime.equals(d('10000.000')));
  assert.ok(detail.cnss.equals(d('1000.000')));
  // salaries alone already use the whole 1200 abattement cap -> none left
  assert.ok(detail.abattement.equals(d('0.000')));
  assert.ok(detail.netImposable.equals(d('9000.000')));
  assert.ok(detail.css.equals(d('180.000')));
  // salaries alone: B = 108000 - 1200 = 106800 -> 29040
  // + prime: B = 115800 -> 31740 -> prime fully in the 30% bracket
  assert.ok(detail.irpp.equals(d('2700.000')));
  assert.ok(netAPayer.equals(d('6120.000'))); // 10000 - 1000 - 2700 - 180
});

test('abattement only uses what is left of the annual cap after the 12 salaries', () => {
  // salaries: R = 990 x 12 = 11880 -> F = 1188 (12 left under the 1200 cap)
  // + prime: 10% of its 990 would be 99, but only 12 is left
  const input = makeInput({ salaireBrutTheorique: d('1100') });
  const { detail } = calculerPrimeGratification(input, makeParams());
  assert.ok(detail.abattement.equals(d('12.000')));
});

test('partial note, partial presence, partial year all scale the prime down', () => {
  const input = makeInput({
    note: d('10'), // half
    heuresTravaillees: d('88'),
    heuresTheoriques: d('176'), // half
    nbMoisPayes: d('6'), // half
  });
  const { detail, netAPayer } = calculerPrimeGratification(input, makeParams());

  // 1000 x 0.5 x 0.5 x 0.5 = 125
  assert.ok(detail.prime.equals(d('125.000')));
  assert.ok(detail.cnss.equals(d('12.500')));
  assert.ok(detail.abattement.equals(d('11.250')));
  assert.ok(detail.netImposable.equals(d('101.250')));
  assert.ok(detail.css.equals(d('2.025')));
  // + prime: R = 10912.5, F = 1091.25, B = ceil(9821.25) = 9822 -> 764.4; 764.4 - 744
  assert.ok(detail.irpp.equals(d('20.400')));
  assert.ok(netAPayer.equals(d('90.075'))); // 125 - 12.5 - 20.4 - 2.025
});

test('zero note -> zero prime, zero everything', () => {
  const input = makeInput({ note: d('0') });
  const { detail, netAPayer } = calculerPrimeGratification(input, makeParams());

  assert.ok(detail.prime.equals(d('0.000')));
  assert.ok(detail.cnss.equals(d('0.000')));
  assert.ok(detail.irpp.equals(d('0.000')));
  assert.ok(netAPayer.equals(d('0.000')));
});

test('heuresTheoriques of zero is rejected rather than dividing by zero', () => {
  const input = makeInput({ heuresTheoriques: d('0') });
  assert.throws(() => calculerPrimeGratification(input, makeParams()), /heuresTheoriques/);
});
