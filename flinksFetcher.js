'use strict';

/**
 * Waves Financial — Flinks Data Fetcher
 *
 * Calls the Flinks API with a loginId and transforms the raw response
 * into the normalised bankData object the scoring engine expects.
 *
 * Output shape:
 *   {
 *     verifiedIncome    : number   Monthly net income (CAD)
 *     fixedObligations  : number   Monthly fixed obligations (CAD)
 *     nsfCount          : number   NSF transactions in last 90 days
 *     oppositionCount   : number   Returned / blocked PADs in last 90 days
 *     accountAgeDays    : number   Age of primary account in days
 *     avgDailyBalance   : number   Average daily balance over 90 days (CAD)
 *     incomeRegularity  : string   'consistent'|'variable'|'irregular'|'undetected'
 *   }
 */

const https = require('https');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const FLINKS_BASE_URL  = process.env.FLINKS_BASE_URL;   // e.g. https://sandbox.flinks.com/v3
const FLINKS_API_KEY   = process.env.FLINKS_API_KEY;
const LOOKBACK_DAYS    = 90;
const REQUEST_TIMEOUT  = 15_000; // ms

// Transaction categories Flinks uses for NSF events
const NSF_CATEGORIES = ['NSF', 'NON_SUFFICIENT_FUNDS', 'INSUFFICIENT_FUNDS'];

// Categories that indicate a returned / opposed PAD
const OPPOSITION_CATEGORIES = [
  'RETURNED_ITEM', 'PAYMENT_RETURNED', 'PAD_RETURNED',
  'PREAUTHORIZED_DEBIT_RETURNED', 'OPPOSITION',
];

// Categories Flinks uses for recurring fixed obligations
const OBLIGATION_CATEGORIES = [
  'MORTGAGE', 'RENT', 'LOAN_PAYMENT', 'CREDIT_CARD_PAYMENT',
  'INSURANCE', 'LEASING', 'LINE_OF_CREDIT_PAYMENT',
];

// Categories that count as regular income deposits
const INCOME_CATEGORIES = [
  'PAYROLL', 'DIRECT_DEPOSIT', 'EMPLOYMENT_INSURANCE',
  'CPP', 'OAS', 'PENSION', 'DISABILITY', 'GOVERNMENT_BENEFIT',
];


// ─── HTTP HELPER ──────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'Authorization': `Bearer ${FLINKS_API_KEY}`,
        'Content-Type':  'application/json',
      },
      timeout: REQUEST_TIMEOUT,
    }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Flinks API error ${res.statusCode}: ${body}`));
        }
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          reject(new Error(`Flinks response parse error: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Flinks API request timed out'));
    });
  });
}


// ─── DATE HELPERS ─────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysBetween(dateA, dateB) {
  return Math.floor(Math.abs(new Date(dateB) - new Date(dateA)) / 86_400_000);
}

function isWithinLookback(dateStr) {
  return new Date(dateStr) >= daysAgo(LOOKBACK_DAYS);
}


// ─── ANALYSIS FUNCTIONS ───────────────────────────────────────────────────────

/**
 * Count NSF transactions in the lookback window.
 */
function countNSF(transactions) {
  return transactions.filter(tx =>
    isWithinLookback(tx.Date) &&
    (
      NSF_CATEGORIES.includes(tx.Category?.toUpperCase()) ||
      NSF_CATEGORIES.some(c => tx.Description?.toUpperCase().includes(c)) ||
      tx.Amount < 0 && tx.Description?.toUpperCase().includes('NSF')
    )
  ).length;
}

/**
 * Count payment oppositions / returned PADs in the lookback window.
 */
function countOppositions(transactions) {
  return transactions.filter(tx =>
    isWithinLookback(tx.Date) &&
    (
      OPPOSITION_CATEGORIES.includes(tx.Category?.toUpperCase()) ||
      OPPOSITION_CATEGORIES.some(c => tx.Description?.toUpperCase().includes(c))
    )
  ).length;
}

/**
 * Detect monthly fixed obligations.
 * Looks for recurring debits in OBLIGATION_CATEGORIES that appear at least
 * twice in the lookback window (i.e. genuinely recurring, not one-off).
 */
function detectFixedObligations(transactions) {
  const lookback = transactions.filter(tx =>
    isWithinLookback(tx.Date) &&
    tx.Amount < 0 &&
    OBLIGATION_CATEGORIES.includes(tx.Category?.toUpperCase())
  );

  // Group by description similarity (simple: trim + lowercase first 30 chars)
  const groups = {};
  for (const tx of lookback) {
    const key = (tx.Description || '').toLowerCase().trim().slice(0, 30);
    if (!groups[key]) groups[key] = [];
    groups[key].push(Math.abs(tx.Amount));
  }

  // Only count groups that appear ≥ 2 times (recurring)
  let totalMonthly = 0;
  for (const [, amounts] of Object.entries(groups)) {
    if (amounts.length >= 2) {
      // Use median amount to avoid outliers
      amounts.sort((a, b) => a - b);
      const median = amounts[Math.floor(amounts.length / 2)];
      // Convert to monthly: 90 days ≈ 3 months
      totalMonthly += median;
    }
  }

  return Math.round(totalMonthly);
}

/**
 * Detect and verify income.
 * Returns { monthlyIncome, regularity }
 *
 * regularity:
 *   'consistent'  — income arrives on a regular schedule, low variance
 *   'variable'    — income arrives regularly but amounts vary significantly
 *   'irregular'   — income detected but timing/amounts are inconsistent
 *   'undetected'  — no recognisable income pattern found
 */
function detectIncome(transactions) {
  const incomeDeposits = transactions.filter(tx =>
    isWithinLookback(tx.Date) &&
    tx.Amount > 0 &&
    (
      INCOME_CATEGORIES.includes(tx.Category?.toUpperCase()) ||
      INCOME_CATEGORIES.some(c => tx.Description?.toUpperCase().includes(c))
    )
  ).sort((a, b) => new Date(a.Date) - new Date(b.Date));

  if (incomeDeposits.length === 0) {
    return { monthlyIncome: 0, regularity: 'undetected' };
  }

  const amounts  = incomeDeposits.map(tx => tx.Amount);
  const totalIncome = amounts.reduce((s, a) => s + a, 0);
  // Annualise: 90 days → × (365/90) → ÷ 12 for monthly
  const monthlyIncome = Math.round(totalIncome / 3);

  if (incomeDeposits.length < 2) {
    return { monthlyIncome, regularity: 'irregular' };
  }

  // Check timing regularity — gaps between deposits
  const gaps = [];
  for (let i = 1; i < incomeDeposits.length; i++) {
    gaps.push(daysBetween(incomeDeposits[i - 1].Date, incomeDeposits[i].Date));
  }
  const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
  const gapVariance = gaps.reduce((s, g) => s + Math.abs(g - avgGap), 0) / gaps.length;

  // Check amount regularity
  const avgAmount   = amounts.reduce((s, a) => s + a, 0) / amounts.length;
  const amountCV    = Math.sqrt(
    amounts.reduce((s, a) => s + Math.pow(a - avgAmount, 2), 0) / amounts.length
  ) / avgAmount; // coefficient of variation

  if (gapVariance <= 3 && amountCV <= 0.10) return { monthlyIncome, regularity: 'consistent' };
  if (gapVariance <= 7 && amountCV <= 0.25) return { monthlyIncome, regularity: 'variable' };
  return { monthlyIncome, regularity: 'irregular' };
}

/**
 * Calculate average daily balance over the lookback window.
 * Uses end-of-day balance snapshots if available, otherwise estimates
 * from running balance reconstruction.
 */
function calcAvgDailyBalance(transactions, currentBalance) {
  const lookback = transactions
    .filter(tx => isWithinLookback(tx.Date))
    .sort((a, b) => new Date(b.Date) - new Date(a.Date)); // newest first

  if (lookback.length === 0) return Math.max(0, currentBalance);

  // Walk backwards from current balance to reconstruct daily balances
  let runningBalance = currentBalance;
  let totalBalance   = currentBalance;
  let daysCounted    = 1;

  for (const tx of lookback) {
    runningBalance -= tx.Amount; // reverse the transaction
    totalBalance   += Math.max(0, runningBalance);
    daysCounted++;
    if (daysCounted >= LOOKBACK_DAYS) break;
  }

  return Math.round(totalBalance / daysCounted);
}

/**
 * Determine account age in days from the account's opening date.
 * Falls back to earliest transaction date if opening date not provided.
 */
function getAccountAgeDays(account, transactions) {
  if (account.OpeningDate) {
    return daysBetween(account.OpeningDate, new Date());
  }
  // Fall back: earliest transaction in the full history
  if (transactions.length > 0) {
    const sorted = [...transactions].sort((a, b) => new Date(a.Date) - new Date(b.Date));
    return daysBetween(sorted[0].Date, new Date());
  }
  return 0;
}


// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

/**
 * fetchBankData(loginId) → Promise<bankData>
 *
 * Makes three Flinks API calls:
 *   1. /accounts/summary          — account list, balances, metadata
 *   2. /accounts/{id}/transactions — transaction history
 *   3. /accounts/{id}/statements   — income statements (Flinks enriched)
 *
 * Returns the normalised bankData object for the scoring engine.
 */
async function fetchBankData(loginId) {
  if (!FLINKS_BASE_URL || !FLINKS_API_KEY) {
    throw new Error('FLINKS_BASE_URL and FLINKS_API_KEY environment variables are required');
  }

  // ── 1. Get accounts ────────────────────────────────────────────────────
  const accountsResponse = await httpGet(
    `${FLINKS_BASE_URL}/accounts/summary?loginId=${loginId}`
  );

  const accounts = accountsResponse.Accounts || [];
  if (accounts.length === 0) {
    throw new Error(`No accounts found for loginId: ${loginId}`);
  }

  // Use the primary chequing account, or fall back to first account
  const primaryAccount = (
    accounts.find(a => a.Type?.toUpperCase() === 'CHECKING') ||
    accounts.find(a => a.Type?.toUpperCase() === 'CHEQUING') ||
    accounts[0]
  );
  const accountId      = primaryAccount.Id;
  const currentBalance = primaryAccount.Balance?.Available ?? primaryAccount.Balance?.Current ?? 0;

  // ── 2. Get transactions ────────────────────────────────────────────────
  const txResponse = await httpGet(
    `${FLINKS_BASE_URL}/accounts/${accountId}/transactions` +
    `?loginId=${loginId}` +
    `&startDate=${daysAgo(LOOKBACK_DAYS).toISOString().slice(0, 10)}` +
    `&endDate=${new Date().toISOString().slice(0, 10)}`
  );

  const transactions = txResponse.Transactions || [];

  // ── 3. Try to get enriched income statements (best-effort) ─────────────
  let enrichedIncome = null;
  try {
    const stmtResponse = await httpGet(
      `${FLINKS_BASE_URL}/accounts/${accountId}/statements?loginId=${loginId}`
    );
    // Flinks statements endpoint returns MonthlyIncome if detected
    enrichedIncome = stmtResponse.MonthlyIncome ?? null;
  } catch {
    // Statements endpoint is optional — fall back to transaction analysis
  }

  // ── 4. Analyse ────────────────────────────────────────────────────────
  const nsfCount        = countNSF(transactions);
  const oppositionCount = countOppositions(transactions);
  const fixedObligations = detectFixedObligations(transactions);
  const accountAgeDays   = getAccountAgeDays(primaryAccount, transactions);
  const avgDailyBalance  = calcAvgDailyBalance(transactions, currentBalance);

  const { monthlyIncome, regularity } = detectIncome(transactions);

  // Prefer Flinks enriched income if available and plausible
  const verifiedIncome = (enrichedIncome && enrichedIncome > 0)
    ? enrichedIncome
    : monthlyIncome;

  return {
    verifiedIncome,
    fixedObligations,
    nsfCount,
    oppositionCount,
    accountAgeDays,
    avgDailyBalance,
    incomeRegularity: regularity,
  };
}


// ─── SANDBOX MOCK ────────────────────────────────────────────────────────────

/**
 * fetchBankDataMock(scenario) → bankData
 *
 * Returns mock bankData for sandbox testing without hitting the Flinks API.
 * Pass a scenario name matching one of the scoring engine tiers.
 *
 * Usage:
 *   const bankData = fetchBankDataMock('gold');
 *   const result   = score(bankData, 3000, 800);
 */
const MOCK_SCENARIOS = {
  gold: {
    verifiedIncome:   3000,
    fixedObligations: 400,
    nsfCount:         0,
    oppositionCount:  0,
    accountAgeDays:   365,
    avgDailyBalance:  800,
    incomeRegularity: 'consistent',
  },
  green: {
    verifiedIncome:   2200,
    fixedObligations: 500,
    nsfCount:         1,
    oppositionCount:  0,
    accountAgeDays:   180,
    avgDailyBalance:  350,
    incomeRegularity: 'consistent',
  },
  blue: {
    verifiedIncome:   1800,
    fixedObligations: 700,
    nsfCount:         3,
    oppositionCount:  0,
    accountAgeDays:   120,
    avgDailyBalance:  100,
    incomeRegularity: 'variable',
  },
  yellow: {
    verifiedIncome:   1600,
    fixedObligations: 900,
    nsfCount:         5,
    oppositionCount:  0,
    accountAgeDays:   90,
    avgDailyBalance:  60,
    incomeRegularity: 'irregular',
  },
  orange: {
    verifiedIncome:   1800,
    fixedObligations: 600,
    nsfCount:         6,
    oppositionCount:  1,
    accountAgeDays:   200,
    avgDailyBalance:  20,
    incomeRegularity: 'irregular',
  },
  red: {
    verifiedIncome:   1200,
    fixedObligations: 1000,
    nsfCount:         8,
    oppositionCount:  2,
    accountAgeDays:   300,
    avgDailyBalance:  20,
    incomeRegularity: 'irregular',
  },
  hard_decline_no_income: {
    verifiedIncome:   0,
    fixedObligations: 0,
    nsfCount:         0,
    oppositionCount:  0,
    accountAgeDays:   200,
    avgDailyBalance:  50,
    incomeRegularity: 'undetected',
  },
  hard_decline_new_account: {
    verifiedIncome:   2500,
    fixedObligations: 300,
    nsfCount:         0,
    oppositionCount:  0,
    accountAgeDays:   30,
    avgDailyBalance:  400,
    incomeRegularity: 'consistent',
  },
};

function fetchBankDataMock(scenario = 'gold') {
  const data = MOCK_SCENARIOS[scenario];
  if (!data) {
    throw new Error(
      `Unknown mock scenario: "${scenario}". ` +
      `Valid options: ${Object.keys(MOCK_SCENARIOS).join(', ')}`
    );
  }
  return { ...data };
}


module.exports = { fetchBankData, fetchBankDataMock, MOCK_SCENARIOS };
