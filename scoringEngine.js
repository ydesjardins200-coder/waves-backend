'use strict';

/**
 * Waves Financial — Scoring Engine
 * Pure function. No I/O. No side effects.
 *
 * Input:  normalizedBankData  (from Flinks fetcher)
 *         declaredIncome      (from step 1 form, monthly net CAD)
 *         requestedAmount     (loan amount applicant selected)
 *
 * Output: ScoringResult
 *   {
 *     score          : number  (0–100, lower = better)
 *     tier           : string  ('gold'|'green'|'blue'|'yellow'|'orange'|'red')
 *     decision       : string  ('auto_approved'|'manual_review'|'auto_declined')
 *     approvedAmount : number  (equals requestedAmount, or feasible amount, or 0)
 *     signals        : object  (every individual signal value + points)
 *     flags          : string[] (human-readable analyst notes)
 *     hardDecline    : string|null (reason if hard gate triggered)
 *   }
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

const APR = 0.23;

const TIERS = [
  { name: 'gold',   min: 0,  max: 15,  decision: 'auto_approved' },
  { name: 'green',  min: 15, max: 30,  decision: 'manual_review' },
  { name: 'blue',   min: 30, max: 50,  decision: 'manual_review' },
  { name: 'yellow', min: 50, max: 70,  decision: 'manual_review' },
  { name: 'orange', min: 70, max: 90,  decision: 'manual_review' },
  { name: 'red',    min: 90, max: 101, decision: 'auto_declined' },
];

// Candidate amounts for feasibility loop (descending — highest revenue first)
const FEASIBILITY_CANDIDATES = [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100];

// DTI threshold for feasibility check
const FEASIBILITY_DTI_LIMIT = 0.75;


// ─── HELPERS ──────────────────────────────────────────────────────────────────

/**
 * Calculate estimated biweekly payment (simple interest, same formula as frontend)
 * Used for DTI calculation and feasibility loop.
 */
function calcBiweeklyPayment(principal) {
  const days = 112; // 8 biweekly periods ≈ 112 days
  const n    = 8;
  return (principal * (1 + APR * days / 365)) / n;
}

/**
 * Determine tier from final score.
 */
function resolveTier(score) {
  return TIERS.find(t => score >= t.min && score < t.max) || TIERS[TIERS.length - 1];
}

/**
 * Find the highest loan amount where projected DTI stays under the limit.
 * Returns 0 if no candidate is feasible.
 *
 * @param {number} fixedObligations  - monthly fixed obligations detected by Flinks (CAD)
 * @param {number} verifiedIncome    - monthly net income verified by Flinks (CAD)
 * @param {number} requestedAmount   - what the applicant asked for
 */
function calcFeasibleAmount(fixedObligations, verifiedIncome, requestedAmount) {
  if (verifiedIncome <= 0) return 0;

  // Start from requested amount, loop down
  const candidates = FEASIBILITY_CANDIDATES.filter(c => c <= requestedAmount);
  // Also include the requested amount itself if not already in the list
  if (!candidates.includes(requestedAmount)) candidates.unshift(requestedAmount);
  candidates.sort((a, b) => b - a); // descending

  for (const amount of candidates) {
    const paymentPerPeriod  = calcBiweeklyPayment(amount);
    const monthlyPayment    = paymentPerPeriod * 2; // biweekly × 2 ≈ monthly
    const projectedDTI      = (fixedObligations + monthlyPayment) / verifiedIncome;
    if (projectedDTI < FEASIBILITY_DTI_LIMIT) {
      return amount;
    }
  }
  return 0; // no feasible amount found
}


// ─── SIGNAL SCORERS ───────────────────────────────────────────────────────────

/** NSF transactions in the last 90 days — max 25 pts */
function scoreNSF(nsfCount) {
  if (nsfCount === 0)        return { points: 0,  band: 'none' };
  if (nsfCount <= 2)         return { points: 8,  band: 'low' };
  if (nsfCount <= 5)         return { points: 16, band: 'moderate' };
  return                            { points: 25, band: 'high' };
}

/** Payment oppositions (returned/blocked PADs) in 90 days — max 20 pts */
function scoreOppositions(oppositionCount) {
  if (oppositionCount === 0) return { points: 0,  band: 'none' };
  if (oppositionCount === 1) return { points: 10, band: 'low' };
  return                            { points: 20, band: 'high' };
}

/** Debt-to-income ratio — max 20 pts */
function scoreDTI(dtiRatio) {
  if (dtiRatio < 0.30)       return { points: 0,  band: 'low' };
  if (dtiRatio < 0.50)       return { points: 8,  band: 'moderate' };
  if (dtiRatio < 0.70)       return { points: 14, band: 'high' };
  return                            { points: 20, band: 'very_high' };
}

/**
 * Income consistency — max 15 pts
 * regularity: 'consistent' | 'variable' | 'irregular' | 'undetected'
 */
function scoreIncomeConsistency(regularity) {
  const map = {
    consistent:  { points: 0,  band: 'consistent' },
    variable:    { points: 6,  band: 'variable' },
    irregular:   { points: 12, band: 'irregular' },
    undetected:  { points: 15, band: 'undetected' },
  };
  return map[regularity] || { points: 15, band: 'undetected' };
}

/** Income mismatch (declared vs Flinks verified) — max 10 pts */
function scoreIncomeMismatch(declaredIncome, verifiedIncome) {
  if (verifiedIncome <= 0) return { points: 10, mismatchRatio: null, band: 'unverifiable' };
  const ratio = Math.abs(declaredIncome - verifiedIncome) / declaredIncome;
  if (ratio < 0.15)  return { points: 0,  mismatchRatio: ratio, band: 'accurate' };
  if (ratio < 0.35)  return { points: 5,  mismatchRatio: ratio, band: 'overstated' };
  return                    { points: 10, mismatchRatio: ratio, band: 'inflated' };
}

/** Average daily balance vs loan amount — max 10 pts */
function scoreBalanceCushion(avgDailyBalance, requestedAmount) {
  if (requestedAmount <= 0) return { points: 0, band: 'n/a' };
  const ratio = avgDailyBalance / requestedAmount;
  if (ratio > 0.30)  return { points: 0, band: 'healthy' };
  if (ratio > 0.10)  return { points: 4, band: 'thin' };
  return                    { points: 10, band: 'critical' };
}


// ─── HARD DECLINE GATES ───────────────────────────────────────────────────────

/**
 * Run hard decline gates before scoring.
 * Returns a reason string if declined, null if all gates pass.
 */
function checkHardDeclineGates(bankData, declaredIncome) {
  const { verifiedIncome, oppositionCount, accountAgeDays, nsfCount } = bankData;

  if (verifiedIncome <= 0 || bankData.incomeRegularity === 'undetected') {
    return 'No verifiable income detected in the last 90 days.';
  }
  if (verifiedIncome < 800) {
    return `Verified monthly income ($${verifiedIncome}) is below the $800 minimum.`;
  }
  if (oppositionCount >= 3) {
    return `${oppositionCount} payment oppositions detected in the last 90 days.`;
  }
  if (accountAgeDays < 60) {
    return `Bank account is only ${accountAgeDays} days old (minimum 60 days required).`;
  }
  return null;
}


// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

/**
 * score(bankData, declaredIncome, requestedAmount) → ScoringResult
 *
 * @param {object} bankData
 *   {
 *     verifiedIncome    : number   Monthly net income detected by Flinks (CAD)
 *     fixedObligations  : number   Monthly fixed obligations detected (rent, loans, etc.)
 *     nsfCount          : number   NSF transactions in last 90 days
 *     oppositionCount   : number   Returned/blocked PAD transactions in last 90 days
 *     accountAgeDays    : number   Age of the primary account in days
 *     avgDailyBalance   : number   Average daily balance over last 90 days (CAD)
 *     incomeRegularity  : string   'consistent' | 'variable' | 'irregular' | 'undetected'
 *   }
 * @param {number} declaredIncome   Monthly net income from step 1 form (CAD)
 * @param {number} requestedAmount  Loan amount applicant selected
 */
function score(bankData, declaredIncome, requestedAmount) {

  // ── 1. Hard decline gates ────────────────────────────────────────────────
  const hardDeclineReason = checkHardDeclineGates(bankData, declaredIncome);
  if (hardDeclineReason) {
    return {
      score:          100,
      tier:           'red',
      decision:       'auto_declined',
      approvedAmount: 0,
      signals: {
        nsfCount:           bankData.nsfCount,
        nsfPoints:          25,
        oppositionCount:    bankData.oppositionCount,
        oppositionPoints:   20,
        dtiRatio:           null,
        dtiPoints:          20,
        verifiedIncome:     bankData.verifiedIncome,
        declaredIncome,
        mismatchRatio:      null,
        mismatchPoints:     10,
        incomeRegularity:   bankData.incomeRegularity,
        regularityPoints:   15,
        avgDailyBalance:    bankData.avgDailyBalance,
        balancePoints:      10,
      },
      flags:       ['Hard decline gate triggered'],
      hardDecline: hardDeclineReason,
    };
  }

  // ── 2. Calculate DTI with the requested loan payment included ────────────
  const monthlyLoanPayment = calcBiweeklyPayment(requestedAmount) * 2;
  const dtiRatio = (bankData.fixedObligations + monthlyLoanPayment) / bankData.verifiedIncome;

  // ── 3. Run all signal scorers ────────────────────────────────────────────
  const nsf         = scoreNSF(bankData.nsfCount);
  const opposition  = scoreOppositions(bankData.oppositionCount);
  const dti         = scoreDTI(dtiRatio);
  const consistency = scoreIncomeConsistency(bankData.incomeRegularity);
  const mismatch    = scoreIncomeMismatch(declaredIncome, bankData.verifiedIncome);
  const balance     = scoreBalanceCushion(bankData.avgDailyBalance, requestedAmount);

  // ── 4. Total score ───────────────────────────────────────────────────────
  const totalScore = Math.min(100,
    nsf.points +
    opposition.points +
    dti.points +
    consistency.points +
    mismatch.points +
    balance.points
  );

  // ── 5. Resolve tier ──────────────────────────────────────────────────────
  const tier = resolveTier(totalScore);

  // ── 6. Approved / feasible amount ───────────────────────────────────────
  let approvedAmount = requestedAmount;
  let feasibleAmount = requestedAmount;

  // Build full feasibility list for all tiers (highest revenue first)
  // This tells the analyst every amount the borrower can afford
  const feasibilityList = tier.name !== 'red'
    ? FEASIBILITY_CANDIDATES.filter(c => {
        const payment = calcBiweeklyPayment(c) * 2;
        const dti = (bankData.fixedObligations + payment) / (bankData.verifiedIncome || 1);
        return dti < FEASIBILITY_DTI_LIMIT;
      })
    : [];

  if (tier.name === 'red') {
    approvedAmount = 0;
    feasibleAmount = 0;
  } else if (tier.name === 'orange') {
    feasibleAmount = calcFeasibleAmount(
      bankData.fixedObligations,
      bankData.verifiedIncome,
      requestedAmount
    );
    // If nothing is feasible, escalate to red
    if (feasibleAmount === 0) {
      return {
        score:          95,
        tier:           'red',
        decision:       'auto_declined',
        approvedAmount: 0,
        feasibilityList: [],
        signals: buildSignals({
          bankData, declaredIncome, dtiRatio,
          nsf, opposition, dti, consistency, mismatch, balance,
        }),
        flags:       ['Orange escalated to Red — no feasible amount found'],
        hardDecline: 'No loan amount produces a DTI below 50% with current obligations.',
      };
    }
    approvedAmount = feasibleAmount;
  }

  // ── 7. Build analyst flags ───────────────────────────────────────────────
  const flags = [];
  if (bankData.nsfCount >= 3)          flags.push(`High NSF activity: ${bankData.nsfCount} in 90 days`);
  if (bankData.oppositionCount >= 1)   flags.push(`Payment opposition(s) detected: ${bankData.oppositionCount}`);
  if (dtiRatio > 0.75)                 flags.push(`DTI elevated: ${(dtiRatio * 100).toFixed(1)}%`);
  if (mismatch.band === 'inflated')    flags.push(`Income overstated by ${((mismatch.mismatchRatio || 0) * 100).toFixed(1)}%`);
  if (balance.band === 'critical')     flags.push(`Average daily balance critically low vs loan amount`);
  if (tier.name === 'orange')          flags.push(`Feasible amount: $${feasibleAmount} (requested: $${requestedAmount})`);
  if (consistency.band === 'irregular') flags.push('Income pattern irregular — manual income verification recommended');

  // ── 8. Return result ─────────────────────────────────────────────────────
  return {
    score:          totalScore,
    tier:           tier.name,
    decision:       tier.decision,
    approvedAmount,
    feasibleAmount: tier.name === 'orange' ? feasibleAmount : requestedAmount,
    feasibilityList,   // full list of affordable amounts [$1000, $900, ...] for analyst
    signals:        buildSignals({
      bankData, declaredIncome, dtiRatio,
      nsf, opposition, dti, consistency, mismatch, balance,
    }),
    flags,
    hardDecline:    null,
  };
}

/** Helper to build the signals object consistently */
function buildSignals({ bankData, declaredIncome, dtiRatio, nsf, opposition, dti, consistency, mismatch, balance }) {
  return {
    nsfCount:          bankData.nsfCount,
    nsfPoints:         nsf.points,
    nsfBand:           nsf.band,

    oppositionCount:   bankData.oppositionCount,
    oppositionPoints:  opposition.points,
    oppositionBand:    opposition.band,

    dtiRatio:          parseFloat(dtiRatio.toFixed(4)),
    dtiPoints:         dti.points,
    dtiBand:           dti.band,

    verifiedIncome:    bankData.verifiedIncome,
    declaredIncome,
    mismatchRatio:     mismatch.mismatchRatio !== null
                         ? parseFloat(mismatch.mismatchRatio.toFixed(4))
                         : null,
    mismatchPoints:    mismatch.points,
    mismatchBand:      mismatch.band,

    incomeRegularity:  bankData.incomeRegularity,
    regularityPoints:  consistency.points,
    regularityBand:    consistency.band,

    avgDailyBalance:   bankData.avgDailyBalance,
    balancePoints:     balance.points,
    balanceBand:       balance.band,

    accountAgeDays:    bankData.accountAgeDays,
    fixedObligations:  bankData.fixedObligations,
  };
}

module.exports = { score, calcFeasibleAmount, calcBiweeklyPayment };
