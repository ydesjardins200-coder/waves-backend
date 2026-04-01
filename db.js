'use strict';

/**
 * Waves Financial — Database Layer
 *
 * All Supabase read/write operations.
 * Every function fails gracefully — a DB error never breaks the applicant's experience.
 *
 * Tables:
 *   applications   — every loan application with full scoring result
 *   auth.users     — managed by Supabase Auth (magic link)
 */

const { supabase } = require('./supabaseClient');


// ─── APPLICATIONS ─────────────────────────────────────────────────────────────

/**
 * Save a completed application to Supabase.
 * Called after the scoring engine runs — stores everything in one row.
 *
 * @param {object} application   Full payload from the browser
 * @param {object} scoringResult Output from scoringEngine.score()
 * @param {object} bankData      Normalised bank data from Flinks
 * @returns {Promise<{id: string}|null>}
 */
async function saveApplication(application, scoringResult, bankData) {
  if (!supabase) {
    console.warn('[db] Supabase not configured — skipping application save');
    return null;
  }

  const { personal, employment, loan, signature, banking } = application;

  const row = {
    // ── Reference ────────────────────────────────────────────────────
    ref:            application.ref,
    submitted_at:   application.submittedAt,
    type:           application.type || 'new',  // 'new' | 'renewal'

    // ── Decision ─────────────────────────────────────────────────────
    decision:       scoringResult.decision,
    tier:           scoringResult.tier,
    risk_score:     scoringResult.score,
    approved_amount: scoringResult.approvedAmount,
    feasible_amount: scoringResult.feasibleAmount ?? scoringResult.approvedAmount,
    hard_decline:   scoringResult.hardDecline,
    flags:          scoringResult.flags,          // stored as jsonb array

    // ── Scoring signals ───────────────────────────────────────────────
    signals:        scoringResult.signals,        // stored as jsonb object

    // ── Applicant ─────────────────────────────────────────────────────
    first_name:     personal?.firstName,
    last_name:      personal?.lastName,
    email:          personal?.email,
    cell_phone:     personal?.cellPhone,
    home_phone:     personal?.homePhone,
    dob:            personal?.dob,
    province:       personal?.province,
    address:        personal?.address,
    city:           personal?.city,
    postal:         personal?.postal,
    // SIN intentionally never stored in DB

    // ── Employment ────────────────────────────────────────────────────
    employment_status:      employment?.source ?? employment?.employmentStatus,
    employer:               employment?.employer,
    pay_frequency:          employment?.payFrequency ?? employment?.payFreq,
    next_pay_date:          employment?.nextPay,
    declared_monthly_income: personal?.declaredIncome ?? employment?.monthlyIncome,

    // ── Loan ──────────────────────────────────────────────────────────
    requested_amount: loan?.amount,
    fund_method:      loan?.fundMethod,

    // ── Bank verification ─────────────────────────────────────────────
    flinks_login_id: banking?.flinksLoginId,
    bank_name:       banking?.institution,
    is_sandbox:      banking?.sandbox ?? false,

    // ── Signature ─────────────────────────────────────────────────────
    esig_name:      signature?.fullName,
    esig_timestamp: signature?.timestamp,

    // ── Verified bank data snapshot ───────────────────────────────────
    verified_income:    bankData?.verifiedIncome,
    fixed_obligations:  bankData?.fixedObligations,
    avg_daily_balance:  bankData?.avgDailyBalance,
    nsf_count:          bankData?.nsfCount,
    opposition_count:   bankData?.oppositionCount,
    account_age_days:   bankData?.accountAgeDays,
    income_regularity:  bankData?.incomeRegularity,
  };

  const { data, error } = await supabase
    .from('applications')
    .insert(row)
    .select('id')
    .single();

  if (error) {
    console.error('[db] Failed to save application:', error.message);
    return null;
  }

  console.log(`[db] Application saved: ${application.ref} (id: ${data.id})`);
  return { id: data.id };
}


/**
 * Fetch a single application by reference number.
 * Used by the customer portal to show loan status.
 */
async function getApplicationByRef(ref) {
  if (!supabase) return null;

  const { data, error } = await supabase
    .from('applications')
    .select('*')
    .eq('ref', ref)
    .single();

  if (error) {
    console.error('[db] getApplicationByRef error:', error.message);
    return null;
  }
  return data;
}


/**
 * Fetch all applications for a given email address.
 * Used by the customer portal to show loan history.
 */
async function getApplicationsByEmail(email) {
  if (!supabase) return [];

  const { data, error } = await supabase
    .from('applications')
    .select('ref, type, decision, tier, risk_score, requested_amount, approved_amount, submitted_at, fund_method')
    .eq('email', email)
    .order('submitted_at', { ascending: false });

  if (error) {
    console.error('[db] getApplicationsByEmail error:', error.message);
    return [];
  }
  return data ?? [];
}


/**
 * Fetch the analyst queue — applications needing manual review.
 * Ordered by tier priority (Green first, Orange last).
 */
async function getReviewQueue() {
  if (!supabase) return [];

  const PRIORITY = { green: 1, blue: 2, yellow: 3, orange: 4 };

  const { data, error } = await supabase
    .from('applications')
    .select('ref, first_name, last_name, email, tier, risk_score, requested_amount, feasible_amount, submitted_at, flags, signals')
    .eq('decision', 'manual_review')
    .is('reviewed_at', null)  // only unreviewed
    .order('submitted_at', { ascending: true });

  if (error) {
    console.error('[db] getReviewQueue error:', error.message);
    return [];
  }

  // Sort by tier priority client-side since Supabase doesn't sort by computed value
  return (data ?? []).sort((a, b) => (PRIORITY[a.tier] ?? 9) - (PRIORITY[b.tier] ?? 9));
}


// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

/**
 * Send a magic link to the given email address.
 * Used by the customer portal login page.
 *
 * @param {string} email
 * @param {string} redirectTo  Full URL to redirect to after login
 */
async function sendMagicLink(email, redirectTo) {
  if (!supabase) return { error: 'Supabase not configured' };

  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: redirectTo },
  });

  if (error) {
    console.error('[db] sendMagicLink error:', error.message);
    return { error: error.message };
  }

  return { success: true };
}


module.exports = {
  saveApplication,
  getApplicationByRef,
  getApplicationsByEmail,
  getReviewQueue,
  sendMagicLink,
};
