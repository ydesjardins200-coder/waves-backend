'use strict';

const { score, calcFeasibleAmount, calcBiweeklyPayment } = require('./scoringEngine');

// ─── TEST HARNESS ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.log(`  ❌ ${label}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

function expectRange(label, actual, min, max) {
  const ok = actual >= min && actual <= max;
  if (ok) {
    console.log(`  ✅ ${label} (${actual} in [${min}, ${max}])`);
    passed++;
  } else {
    console.log(`  ❌ ${label} — ${actual} is NOT in [${min}, ${max}]`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(60 - title.length)}`);
}

// ─── BASE FIXTURES ────────────────────────────────────────────────────────────

/** A perfect applicant — should land in Gold */
const GOLD_BANK = {
  verifiedIncome:   3000,
  fixedObligations: 400,
  nsfCount:         0,
  oppositionCount:  0,
  accountAgeDays:   365,
  avgDailyBalance:  800,
  incomeRegularity: 'consistent',
};

/** A solid applicant — should land in Green */
const GREEN_BANK = {
  verifiedIncome:   2200,
  fixedObligations: 500,
  nsfCount:         1,
  oppositionCount:  0,
  accountAgeDays:   180,
  avgDailyBalance:  350,
  incomeRegularity: 'consistent',
};

/** Moderate risk — should land in Blue */
const BLUE_BANK = {
  verifiedIncome:   1800,
  fixedObligations: 700,
  nsfCount:         3,
  oppositionCount:  0,
  accountAgeDays:   120,
  avgDailyBalance:  100,
  incomeRegularity: 'variable',
};

/** Risky — should land in Yellow */
const YELLOW_BANK = {
  verifiedIncome:   1600,
  fixedObligations: 900,
  nsfCount:         5,
  oppositionCount:  0,
  accountAgeDays:   90,
  avgDailyBalance:  60,
  incomeRegularity: 'irregular',
};

/** Heavy debt — should land in Orange */
const ORANGE_BANK = {
  verifiedIncome:   1800,
  fixedObligations: 600,
  nsfCount:         6,
  oppositionCount:  1,
  accountAgeDays:   200,
  avgDailyBalance:  20,
  incomeRegularity: 'irregular',
};

/** Extreme — should land in Red */
const RED_BANK = {
  verifiedIncome:   1200,
  fixedObligations: 1000,
  nsfCount:         8,
  oppositionCount:  2,
  accountAgeDays:   300,
  avgDailyBalance:  20,
  incomeRegularity: 'irregular',
};

// ─── TESTS ────────────────────────────────────────────────────────────────────

section('GOLD tier — auto approval')
{
  const result = score(GOLD_BANK, 3000, 800);
  expectRange('score lands in Gold range', result.score, 0, 14);
  expect('tier is gold',           result.tier,           'gold');
  expect('decision auto_approved', result.decision,       'auto_approved');
  expect('approved amount = 800',  result.approvedAmount, 800);
  expect('no hard decline',        result.hardDecline,    null);
  expect('no flags',               result.flags.length === 0, true);
}

section('GREEN tier — priority 1 manual review')
{
  const result = score(GREEN_BANK, 2200, 800);
  expectRange('score lands in Green range', result.score, 15, 29);
  expect('tier is green',          result.tier,     'green');
  expect('decision manual_review', result.decision, 'manual_review');
  expect('approved amount = 800',  result.approvedAmount, 800);
}

section('BLUE tier — priority 2 manual review')
{
  const result = score(BLUE_BANK, 2000, 800);
  expectRange('score lands in Blue range', result.score, 30, 49);
  expect('tier is blue',           result.tier,     'blue');
  expect('decision manual_review', result.decision, 'manual_review');
}

section('YELLOW tier — risky, manual review')
{
  const result = score(YELLOW_BANK, 1800, 800);
  expectRange('score lands in Yellow range', result.score, 50, 69);
  expect('tier is yellow',         result.tier,     'yellow');
  expect('decision manual_review', result.decision, 'manual_review');
}

section('ORANGE tier — feasible amount calculated')
{
  const result = score(ORANGE_BANK, 2800, 800); // declared income inflated → extra mismatch pts
  expectRange('score lands in Orange range', result.score, 70, 89);
  expect('tier is orange',              result.tier,     'orange');
  expect('decision manual_review',      result.decision, 'manual_review');
  expect('feasible amount is a number', typeof result.feasibleAmount === 'number', true);
  expect('feasible amount > 0',         result.feasibleAmount > 0, true);
  expect('feasible amount ≤ requested', result.feasibleAmount <= 800, true);
  expect('flags mention feasible',      result.flags.some(f => f.includes('Feasible amount')), true);
}

section('RED tier — auto declined')
{
  const result = score(RED_BANK, 1200, 800);
  expectRange('score lands in Red range', result.score, 90, 100);
  expect('tier is red',            result.tier,           'red');
  expect('decision auto_declined', result.decision,       'auto_declined');
  expect('approved amount = 0',    result.approvedAmount, 0);
}

section('HARD DECLINE — no income detected')
{
  const noIncome = { ...GOLD_BANK, verifiedIncome: 0, incomeRegularity: 'undetected' };
  const result = score(noIncome, 2000, 800);
  expect('tier is red',            result.tier,           'red');
  expect('decision auto_declined', result.decision,       'auto_declined');
  expect('hardDecline is set',     typeof result.hardDecline === 'string', true);
  expect('approved amount = 0',    result.approvedAmount, 0);
}

section('HARD DECLINE — income below $800')
{
  const lowIncome = { ...GOLD_BANK, verifiedIncome: 650 };
  const result = score(lowIncome, 650, 800);
  expect('tier is red',            result.tier,     'red');
  expect('hardDecline is set',     typeof result.hardDecline === 'string', true);
}

section('HARD DECLINE — 3+ payment oppositions')
{
  const manyOppositions = { ...GREEN_BANK, oppositionCount: 3 };
  const result = score(manyOppositions, 2200, 800);
  expect('tier is red',            result.tier,           'red');
  expect('decision auto_declined', result.decision,       'auto_declined');
  expect('hardDecline mentions oppositions',
    result.hardDecline.includes('opposition'), true);
}

section('HARD DECLINE — account too young')
{
  const newAccount = { ...GOLD_BANK, accountAgeDays: 45 };
  const result = score(newAccount, 3000, 800);
  expect('tier is red',        result.tier, 'red');
  expect('hardDecline is set', typeof result.hardDecline === 'string', true);
}

section('ORANGE escalates to RED when no feasible amount')
{
  // Score would be Orange (81) but no amount produces DTI < 75% → escalates to Red
  const impossible = {
    verifiedIncome:   1200,
    fixedObligations: 874,   // 72.8% base DTI — even $100 loan pushes total DTI above 75% limit
    nsfCount:         6,
    oppositionCount:  1,
    accountAgeDays:   200,
    avgDailyBalance:  5,
    incomeRegularity: 'irregular',
  };
  const result = score(impossible, 3000, 800);
  expect('tier is red',            result.tier,     'red');
  expect('decision auto_declined', result.decision, 'auto_declined');
  expect('flags mention escalation',
    result.flags.some(f => f.includes('escalated to Red')), true);
  expect('hardDecline explains reason', typeof result.hardDecline === 'string', true);
}

section('NSF signal — correct point bands')
{
  const base = { ...GOLD_BANK };

  const r0 = score({ ...base, nsfCount: 0 }, 3000, 800);
  const r2 = score({ ...base, nsfCount: 2 }, 3000, 800);
  const r5 = score({ ...base, nsfCount: 5 }, 3000, 800);
  const r9 = score({ ...base, nsfCount: 9 }, 3000, 800);

  expect('0 NSFs → 0 pts',    r0.signals.nsfPoints, 0);
  expect('2 NSFs → 8 pts',    r2.signals.nsfPoints, 8);
  expect('5 NSFs → 16 pts',   r5.signals.nsfPoints, 16);
  expect('9 NSFs → 25 pts',   r9.signals.nsfPoints, 25);
}

section('Opposition signal — correct point bands')
{
  const base = { ...GOLD_BANK };

  const r0 = score({ ...base, oppositionCount: 0 }, 3000, 800);
  const r1 = score({ ...base, oppositionCount: 1 }, 3000, 800);
  const r2 = score({ ...base, oppositionCount: 2 }, 3000, 800);

  expect('0 oppositions → 0 pts',  r0.signals.oppositionPoints, 0);
  expect('1 opposition → 10 pts',  r1.signals.oppositionPoints, 10);
  expect('2 oppositions → 20 pts', r2.signals.oppositionPoints, 20);
}

section('DTI signal — correct point bands')
{
  // DTI = (fixedObligations + monthlyLoanPayment) / verifiedIncome
  // We control fixedObligations to hit each band
  const income = 3000;

  const lowDTI    = score({ ...GOLD_BANK, verifiedIncome: income, fixedObligations: 100  }, income, 800);
  const modDTI    = score({ ...GOLD_BANK, verifiedIncome: income, fixedObligations: 700  }, income, 800);
  const highDTI   = score({ ...GOLD_BANK, verifiedIncome: income, fixedObligations: 1400 }, income, 800);
  const vHighDTI  = score({ ...GOLD_BANK, verifiedIncome: income, fixedObligations: 2200 }, income, 800);

  expect('low DTI → 0 pts',       lowDTI.signals.dtiPoints,   0);
  expect('moderate DTI → 8 pts',  modDTI.signals.dtiPoints,   8);
  expect('high DTI → 14 pts',     highDTI.signals.dtiPoints,  14);
  expect('very high DTI → 20 pts',vHighDTI.signals.dtiPoints, 20);
}

section('Income mismatch signal')
{
  const base = { ...GOLD_BANK, verifiedIncome: 2000 };

  const accurate   = score(base, 2100,  800); // 5% off → 0 pts
  const overstated = score(base, 2700,  800); // 35% off → 5 pts
  const inflated   = score(base, 3500,  800); // 75% off → 10 pts

  expect('accurate → 0 pts',    accurate.signals.mismatchPoints,   0);
  expect('overstated → 5 pts',  overstated.signals.mismatchPoints, 5);
  expect('inflated → 10 pts',   inflated.signals.mismatchPoints,   10);
}

section('Balance cushion signal')
{
  const base = { ...GOLD_BANK };

  const healthy  = score({ ...base, avgDailyBalance: 400  }, 3000, 800); // 50% of 800 → 0 pts
  const thin     = score({ ...base, avgDailyBalance: 120  }, 3000, 800); // 15% of 800 → 4 pts
  const critical = score({ ...base, avgDailyBalance: 40   }, 3000, 800); // 5% of 800  → 10 pts

  expect('healthy balance → 0 pts',   healthy.signals.balancePoints,  0);
  expect('thin balance → 4 pts',      thin.signals.balancePoints,     4);
  expect('critical balance → 10 pts', critical.signals.balancePoints, 10);
}

section('Income consistency signal')
{
  const base = { ...GOLD_BANK };

  const r_c = score({ ...base, incomeRegularity: 'consistent' }, 3000, 800);
  const r_v = score({ ...base, incomeRegularity: 'variable'   }, 3000, 800);
  const r_i = score({ ...base, incomeRegularity: 'irregular'  }, 3000, 800);

  expect('consistent → 0 pts',  r_c.signals.regularityPoints, 0);
  expect('variable → 6 pts',    r_v.signals.regularityPoints, 6);
  expect('irregular → 12 pts',  r_i.signals.regularityPoints, 12);
}

section('Feasibility loop — calcFeasibleAmount')
{
  // obligations=600, income=1500 → monthly payment must keep DTI < 75%
  // budget for loan payment = (0.75 * 1500) - 600 = 525/month = 262.5/biweekly
  const income = 1500;
  const obligations = 600;
  const result = calcFeasibleAmount(obligations, income, 800);

  expect('returns a number',       typeof result === 'number', true);
  expect('result ≤ 800',           result <= 800,              true);
  expect('result is a valid step', [0,100,200,300,400,500,600,700,800].includes(result), true);

  // verify the result actually satisfies the constraint
  if (result > 0) {
    const payment = calcBiweeklyPayment(result) * 2;
    const dti = (obligations + payment) / income;
    expect('DTI < 75% for feasible amount', dti < 0.75, true);
  }
}

section('Feasibility loop — impossible scenario')
{
  const result = calcFeasibleAmount(1400, 1500, 800);
  // obligations already at 93% DTI — no room for any loan
  expect('returns 0 when impossible', result, 0);
}

section('Score total never exceeds 100')
{
  const worstCase = {
    verifiedIncome:   900,   // just above hard gate
    fixedObligations: 800,
    nsfCount:         99,
    oppositionCount:  2,
    accountAgeDays:   61,
    avgDailyBalance:  1,
    incomeRegularity: 'irregular',
  };
  const result = score(worstCase, 3000, 800);
  expect('score ≤ 100', result.score <= 100, true);
}

section('Signals object is always complete')
{
  const result = score(GOLD_BANK, 3000, 800);
  const required = [
    'nsfCount','nsfPoints','nsfBand',
    'oppositionCount','oppositionPoints','oppositionBand',
    'dtiRatio','dtiPoints','dtiBand',
    'verifiedIncome','declaredIncome','mismatchRatio','mismatchPoints','mismatchBand',
    'incomeRegularity','regularityPoints','regularityBand',
    'avgDailyBalance','balancePoints','balanceBand',
    'accountAgeDays','fixedObligations',
  ];
  required.forEach(key => {
    expect(`signals.${key} exists`, key in result.signals, true);
  });
}

section('calcBiweeklyPayment — sanity check')
{
  const p800 = calcBiweeklyPayment(800);
  const p400 = calcBiweeklyPayment(400);

  expect('$800 payment is a positive number',    p800 > 0,             true);
  expect('$400 payment is ~half of $800',        Math.abs(p400 - p800 / 2) < 1, true);
  expectRange('$800 biweekly payment is reasonable', p800, 100, 115);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(64));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);
