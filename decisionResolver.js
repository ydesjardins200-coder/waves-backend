'use strict';

/**
 * Waves Financial — Decision Resolver
 *
 * Orchestrates the full decision pipeline:
 *   1. Fetch bank data from Flinks (or mock in sandbox)
 *   2. Run the scoring engine
 *   3. Build the CRM payload
 *   4. POST to the CRM endpoint
 *   5. Return the frontend response
 *
 * Usage:
 *   const { resolveApplication } = require('./decisionResolver');
 *   const frontendResponse = await resolveApplication(applicationPayload);
 */

const https = require('https');
const { fetchBankData, fetchBankDataMock } = require('./flinksFetcher');
const { score } = require('./scoringEngine');
const { saveApplication } = require('./db');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const CRM_ENDPOINT  = process.env.CRM_ENDPOINT;   // your REST POST URL
const CRM_API_KEY   = process.env.CRM_API_KEY;    // if your CRM requires auth
const IS_SANDBOX    = process.env.NODE_ENV !== 'production';

// Priority levels sent to the CRM per tier
const TIER_PRIORITY = {
  gold:   0,   // auto-approved, no queue needed
  green:  1,
  blue:   2,
  yellow: 3,
  orange: 4,
  red:    0,   // auto-declined, no queue needed
};

// Human-readable labels for the CRM
const TIER_LABELS = {
  gold:   'Great file — auto approved',
  green:  'Good file — priority review',
  blue:   'OK file — standard review',
  yellow: 'Risky — analyst review required',
  orange: 'Heavy debt — feasible amount surfaced',
  red:    'Extreme risk — auto declined',
};


// ─── CRM POST ────────────────────────────────────────────────────────────────

function postToCRM(payload) {
  return new Promise((resolve, reject) => {
    if (!CRM_ENDPOINT) {
      console.warn('[decisionResolver] CRM_ENDPOINT not set — skipping CRM POST');
      return resolve({ skipped: true });
    }

    const body    = JSON.stringify(payload);
    const url     = new URL(CRM_ENDPOINT);
    const options = {
      hostname: url.hostname,
      port:     url.port || 443,
      path:     url.pathname + url.search,
      method:   'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(CRM_API_KEY ? { 'Authorization': `Bearer ${CRM_API_KEY}` } : {}),
      },
      timeout: 10_000,
    };

    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`CRM POST failed: ${res.statusCode} — ${data}`));
        }
        try { resolve(JSON.parse(data)); }
        catch { resolve({ raw: data }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('CRM POST timed out'));
    });

    req.write(body);
    req.end();
  });
}


// ─── CRM PAYLOAD BUILDER ─────────────────────────────────────────────────────

function buildCRMPayload(application, scoringResult, bankData) {
  const { personal, employment, loan, safetyContact, signature, banking } = application;
  const tier = scoringResult.tier;

  return {
    // ── Identity ────────────────────────────────────────────────────────
    ref:         application.ref,
    submittedAt: application.submittedAt,

    // ── Decision ────────────────────────────────────────────────────────
    decision:    scoringResult.decision,
    tier,
    tierLabel:   TIER_LABELS[tier],
    priority:    TIER_PRIORITY[tier],
    score:       scoringResult.score,

    // ── Loan ────────────────────────────────────────────────────────────
    loan: {
      requested:  loan.amount,
      approved:   scoringResult.approvedAmount,
      feasible:   scoringResult.feasibleAmount ?? scoringResult.approvedAmount,
    },

    // ── Scoring signals ─────────────────────────────────────────────────
    signals: scoringResult.signals,
    flags:   scoringResult.flags,
    hardDeclineReason: scoringResult.hardDecline,

    // ── Applicant ───────────────────────────────────────────────────────
    applicant: {
      firstName:        personal.firstName,
      lastName:         personal.lastName,
      email:            personal.email,
      homePhone:        personal.homePhone,
      cellPhone:        personal.cellPhone,
      dob:              personal.dob,
      province:         personal.province,
      address:          personal.address,
      city:             personal.city,
      postal:           personal.postal,
      // SIN intentionally omitted from CRM payload — store only on secure backend
    },

    // ── Employment ──────────────────────────────────────────────────────
    employment: {
      status:       employment.employmentStatus ?? employment.source,
      employer:     employment.employer,
      payFrequency: employment.payFrequency ?? employment.payFreq,
      nextPayDate:  employment.nextPay,
      declaredMonthlyIncome: personal.declaredIncome ?? employment.monthlyIncome,
    },

    // ── Signature ───────────────────────────────────────────────────────
    signature: {
      fullName:  signature.fullName,
      timestamp: signature.timestamp,
    },

    // ── Banking (Flinks) ────────────────────────────────────────────────
    banking: {
      flinksLoginId:  banking.flinksLoginId,
      institution:    banking.institution,
      sandbox:        banking.sandbox ?? false,
      verifiedAt:     new Date().toISOString(),
    },

    // ── Safety contact (for manual review tiers) ────────────────────────
    ...(application.safetyContact ? {
      safetyContact: {
        firstName:    safetyContact.firstName,
        lastName:     safetyContact.lastName,
        phone:        safetyContact.phone,
        relationship: safetyContact.relationship,
      },
    } : {}),
  };
}


// ─── FRONTEND RESPONSE BUILDER ───────────────────────────────────────────────

function buildFrontendResponse(scoringResult, application) {
  const { tier, decision, score: riskScore, approvedAmount, feasibleAmount, hardDecline } = scoringResult;

  // Base response — always included
  const response = {
    ref:      application.ref,
    decision,
    tier,
    score:    riskScore,
  };

  if (decision === 'auto_approved') {
    return {
      ...response,
      approvedAmount,
      message:   'Your application has been approved!',
      nextSteps: [
        'Your loan agreement has been countersigned.',
        `$${approvedAmount.toLocaleString()} will be sent via Interac e-Transfer within 2 minutes.`,
        `Check your email at ${application.personal?.email} for your confirmation.`,
      ],
    };
  }

  if (decision === 'auto_declined') {
    // Keep decline reason vague for the applicant — full reason goes to CRM only
    return {
      ...response,
      approvedAmount: 0,
      message:   'We are unable to approve this application at this time.',
      reason:    hardDecline
        ? 'application_criteria'   // generic — don't expose internal reason to browser
        : 'risk_assessment',
      alternatives: [
        { label: 'Talk to our team',    url: '/contact.html' },
        { label: 'Read the FAQ',        url: '/faq.html' },
        { label: 'How it works',        url: '/how-it-works.html' },
      ],
    };
  }

  // manual_review — all tiers between Gold and Red
  return {
    ...response,
    approvedAmount: null,   // amount determined after analyst review
    message:   'Your application is under review.',
    nextSteps: [
      'Our team will review your application during business hours.',
      'You will receive an email with our decision shortly.',
      'No further action is required from you at this time.',
    ],
  };
}


// ─── MAIN FUNCTION ────────────────────────────────────────────────────────────

/**
 * resolveApplication(applicationPayload) → Promise<frontendResponse>
 *
 * @param {object} applicationPayload  The full payload POSTed from the browser
 *   (matches the shape built in apply.html's submitNew() / submitRenewal())
 */
async function resolveApplication(applicationPayload) {
  const { banking, personal, loan } = applicationPayload;

  // ── 1. Fetch bank data ───────────────────────────────────────────────
  let bankData;
  if (IS_SANDBOX || banking.sandbox) {
    // In sandbox mode, derive a scenario from the flinksLoginId prefix
    // (e.g. "sandbox-gold-abc123" → gold scenario)
    const scenarioMatch = banking.flinksLoginId?.match(/sandbox-([a-z]+)-/);
    const scenario = scenarioMatch ? scenarioMatch[1] : 'green';
    bankData = fetchBankDataMock(scenario);
  } else {
    bankData = await fetchBankData(banking.flinksLoginId);
  }

  // ── 2. Run scoring engine ────────────────────────────────────────────
  const declaredIncome   = Number(personal?.declaredIncome ?? 0) ||
                           Number(applicationPayload.employment?.monthlyIncome ?? 0);
  const requestedAmount  = Number(loan?.amount ?? 800);

  const scoringResult = score(bankData, declaredIncome, requestedAmount);

  // ── 3. Build CRM payload ─────────────────────────────────────────────
  const crmPayload = buildCRMPayload(applicationPayload, scoringResult, bankData);

  // ── 4a. Save to Supabase (fire-and-forget) ───────────────────────────
  saveApplication(applicationPayload, scoringResult, bankData).catch(err => {
    console.error('[decisionResolver] Supabase save failed:', err.message);
  });

  // ── 4b. POST to CRM if configured (fire-and-forget) ──────────────────
  postToCRM(crmPayload).catch(err => {
    console.error('[decisionResolver] CRM POST failed:', err.message);
  });

  // ── 5. Return frontend response ──────────────────────────────────────
  return buildFrontendResponse(scoringResult, applicationPayload);
}


module.exports = { resolveApplication, buildCRMPayload, buildFrontendResponse };
