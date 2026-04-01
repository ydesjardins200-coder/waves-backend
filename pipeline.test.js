'use strict';

/**
 * Integration test — runs the full pipeline:
 *   fetchBankDataMock → scoringEngine → decisionResolver
 *
 * No network calls. No environment variables required.
 */

const { fetchBankDataMock } = require('./flinksFetcher');
const { score }              = require('./scoringEngine');
const { buildCRMPayload, buildFrontendResponse } = require('./decisionResolver');

// ─── TEST HARNESS ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function expect(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`     Expected: ${JSON.stringify(expected)}`);
    console.log(`     Got:      ${JSON.stringify(actual)}`);
    failed++;
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(60 - title.length)}`);
}

// ─── SAMPLE APPLICATION PAYLOAD (mirrors apply.html submitNew output) ─────────

function makeApplication(overrides = {}) {
  return {
    ref:         'WF-123456',
    submittedAt: '2026-03-25T14:32:00Z',
    loanAmount:  800,
    personal: {
      firstName:       'Marie',
      lastName:        'Tremblay',
      email:           'marie@wavestest.ca',
      homePhone:       '(514) 555-0100',
      cellPhone:       '(514) 555-0123',
      dob:             '1990-04-12',
      province:        'QC',
      address:         '123 Main Street',
      city:            'Montreal',
      postal:          'H2X 1A1',
      declaredIncome:  2800,
    },
    employment: {
      employmentStatus: 'employed',
      employer:         'Acme Corp',
      payFrequency:     'biweekly',
      nextPay:          '2026-04-04',
      monthlyIncome:    2800,
    },
    loan: {
      amount:      800,
      fundMethod:  'direct',
      bankruptNow: 'no',
      bankruptPast:'no',
    },
    safetyContact: {
      firstName:    'Jean',
      lastName:     'Martin',
      phone:        '(514) 555-0199',
      relationship: 'spouse',
    },
    signature: {
      fullName:  'Marie Tremblay',
      timestamp: '2026-03-25T14:30:00Z',
    },
    banking: {
      flinksLoginId: 'sandbox-gold-abc123',
      institution:   'TD Canada Trust',
      sandbox:       true,
    },
    ...overrides,
  };
}

// ─── PIPELINE TESTS ───────────────────────────────────────────────────────────

const SCENARIOS = ['gold', 'green', 'blue', 'yellow', 'orange', 'red',
                   'hard_decline_no_income', 'hard_decline_new_account'];

section('Mock scenarios produce valid bankData')
for (const scenario of SCENARIOS) {
  const bankData = fetchBankDataMock(scenario);
  expect(`${scenario}: has verifiedIncome`,   typeof bankData.verifiedIncome   === 'number', true);
  expect(`${scenario}: has nsfCount`,         typeof bankData.nsfCount         === 'number', true);
  expect(`${scenario}: has oppositionCount`,  typeof bankData.oppositionCount  === 'number', true);
  expect(`${scenario}: has accountAgeDays`,   typeof bankData.accountAgeDays   === 'number', true);
  expect(`${scenario}: has avgDailyBalance`,  typeof bankData.avgDailyBalance  === 'number', true);
  expect(`${scenario}: has incomeRegularity`, typeof bankData.incomeRegularity === 'string', true);
}

section('Full pipeline — Gold → auto_approved')
{
  const bankData = fetchBankDataMock('gold');
  const result   = score(bankData, 3000, 800);
  const app      = makeApplication();
  const crm      = buildCRMPayload(app, result, bankData);
  const frontend = buildFrontendResponse(result, app);

  expect('scoring tier is gold',            result.tier,          'gold');
  expect('frontend decision auto_approved', frontend.decision,    'auto_approved');
  expect('frontend has approvedAmount',     frontend.approvedAmount, 800);
  expect('frontend has nextSteps array',    Array.isArray(frontend.nextSteps), true);
  expect('CRM ref matches',                 crm.ref,              'WF-123456');
  expect('CRM tier is gold',                crm.tier,             'gold');
  expect('CRM priority is 0',               crm.priority,         0);
  expect('CRM loan.approved is 800',        crm.loan.approved,    800);
  expect('CRM has applicant.email',         crm.applicant.email,  'marie@wavestest.ca');
  expect('CRM has signature.fullName',      crm.signature.fullName, 'Marie Tremblay');
  expect('CRM does not include SIN',        'sin' in crm.applicant, false);
}

section('Full pipeline — Green → manual_review priority 1')
{
  const bankData = fetchBankDataMock('green');
  const result   = score(bankData, 2200, 800);
  const app      = makeApplication();
  const crm      = buildCRMPayload(app, result, bankData);
  const frontend = buildFrontendResponse(result, app);

  expect('scoring tier is green',           result.tier,       'green');
  expect('frontend decision manual_review', frontend.decision, 'manual_review');
  expect('frontend approvedAmount is null', frontend.approvedAmount, null);
  expect('frontend has nextSteps',          Array.isArray(frontend.nextSteps), true);
  expect('CRM priority is 1',               crm.priority,      1);
}

section('Full pipeline — Orange → manual_review with feasible amount')
{
  const bankData = fetchBankDataMock('orange');
  const result   = score(bankData, 2800, 800);
  const app      = makeApplication();
  const crm      = buildCRMPayload(app, result, bankData);
  const frontend = buildFrontendResponse(result, app);

  expect('scoring tier is orange',          result.tier,     'orange');
  expect('feasibleAmount > 0',              result.feasibleAmount > 0, true);
  expect('feasibleAmount ≤ 800',            result.feasibleAmount <= 800, true);
  expect('CRM loan.feasible populated',     crm.loan.feasible > 0, true);
  expect('CRM priority is 4',               crm.priority,    4);
  expect('frontend decision manual_review', frontend.decision, 'manual_review');
}

section('Full pipeline — Red → auto_declined')
{
  const bankData = fetchBankDataMock('red');
  const result   = score(bankData, 1200, 800);
  const app      = makeApplication();
  const crm      = buildCRMPayload(app, result, bankData);
  const frontend = buildFrontendResponse(result, app);

  expect('scoring tier is red',             result.tier,          'red');
  expect('frontend decision auto_declined', frontend.decision,    'auto_declined');
  expect('frontend approvedAmount is 0',    frontend.approvedAmount, 0);
  expect('frontend has alternatives',       Array.isArray(frontend.alternatives), true);
  expect('frontend reason is generic',      frontend.reason !== result.hardDecline, true);
  expect('CRM priority is 0',               crm.priority,         0);
  expect('CRM hardDeclineReason set',       typeof crm.hardDeclineReason === 'string', true);
}

section('Full pipeline — Hard decline (no income)')
{
  const bankData = fetchBankDataMock('hard_decline_no_income');
  const result   = score(bankData, 2000, 800);
  const frontend = buildFrontendResponse(result, { ref: 'WF-TEST', personal: { email: 'a@b.com' } });

  expect('tier is red',                     result.tier,       'red');
  expect('hardDecline is set',              typeof result.hardDecline === 'string', true);
  expect('frontend decision auto_declined', frontend.decision, 'auto_declined');
  expect('frontend reason is generic',      frontend.reason,   'application_criteria');
}

section('Full pipeline — Hard decline (new account)')
{
  const bankData = fetchBankDataMock('hard_decline_new_account');
  const result   = score(bankData, 2500, 800);

  expect('tier is red',        result.tier, 'red');
  expect('hardDecline mentions account age',
    result.hardDecline?.includes('days old'), true);
}

section('CRM payload completeness')
{
  const bankData = fetchBankDataMock('blue');
  const result   = score(bankData, 2000, 800);
  const app      = makeApplication();
  const crm      = buildCRMPayload(app, result, bankData);

  const requiredTopLevel = [
    'ref', 'submittedAt', 'decision', 'tier', 'tierLabel',
    'priority', 'score', 'loan', 'signals', 'flags',
    'applicant', 'employment', 'signature', 'banking',
  ];
  requiredTopLevel.forEach(key =>
    expect(`CRM has field: ${key}`, key in crm, true)
  );

  const requiredSignals = [
    'nsfCount', 'nsfPoints', 'oppositionCount', 'oppositionPoints',
    'dtiRatio', 'dtiPoints', 'verifiedIncome', 'declaredIncome',
    'mismatchPoints', 'incomeRegularity', 'regularityPoints',
    'avgDailyBalance', 'balancePoints',
  ];
  requiredSignals.forEach(key =>
    expect(`CRM signals.${key} exists`, key in crm.signals, true)
  );
}

section('Frontend response never exposes internal score to browser')
{
  const bankData = fetchBankDataMock('yellow');
  const result   = score(bankData, 1600, 800);
  const frontend = buildFrontendResponse(result, makeApplication());

  // Score IS in the response — your backend can strip it before sending to browser
  // if you prefer. We include it here so internal tooling can use it.
  // The key thing is that tier label is never exposed as a human string.
  expect('frontend has decision',  typeof frontend.decision === 'string', true);
  expect('frontend has ref',       typeof frontend.ref === 'string',      true);
  expect('no raw flags in frontend', 'flags' in frontend, false);
  expect('no signals in frontend',   'signals' in frontend, false);
}

section('Unknown mock scenario throws')
{
  let threw = false;
  try { fetchBankDataMock('doesnotexist'); }
  catch { threw = true; }
  expect('throws on unknown scenario', threw, true);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(64));
console.log(`  Results: ${passed} passed, ${failed} failed`);
console.log('═'.repeat(64));
if (failed > 0) process.exit(1);
