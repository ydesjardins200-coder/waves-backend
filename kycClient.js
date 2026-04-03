'use strict';

/**
 * Waves Financial — KYC/AML Compliance Client
 *
 * Provider: KYC2020 (kyc2020.com) — Canadian company, FINTRAC-focused
 * API docs: https://www.kyc2020.com/api
 *
 * Screens every new borrower against:
 *   - OFAC / UN / Canadian sanctions lists (1,500+ global lists)
 *   - PEP (Politically Exposed Persons)
 *   - RCA (Relatives & Close Associates of PEPs)
 *   - Adverse media / negative news
 *
 * Required env vars (add to Railway when credentials arrive):
 *   KYC_API_KEY     — from KYC2020 dashboard
 *   KYC_API_URL     — https://api.kyc2020.com/v1  (production)
 *                     https://sandbox.kyc2020.com/v1 (sandbox)
 *
 * Result stored in loan_applications:
 *   kyc_status      — 'clear' | 'flag' | 'pending' | 'skipped' | 'error'
 *   kyc_result      — JSON with match details
 *   kyc_checked_at  — timestamp
 */

const https = require('https');

const KYC_API_KEY = process.env.KYC_API_KEY || null;
const KYC_API_URL = process.env.KYC_API_URL || 'https://api.kyc2020.com/v1';
const KYC_ENABLED = process.env.KYC_ENABLED === 'true';

// ── STATUS ────────────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(KYC_API_KEY && KYC_ENABLED);
}

function getStatus() {
  return {
    enabled:    KYC_ENABLED,
    configured: isConfigured(),
    provider:   'KYC2020',
    apiUrl:     KYC_API_URL,
    apiKeySet:  !!KYC_API_KEY,
    sandbox:    KYC_API_URL.includes('sandbox'),
  };
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function kycRequest(path, payload) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(payload);
    const url     = new URL(KYC_API_URL + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      port:     443,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization':  `Bearer ${KYC_API_KEY}`,
        'Accept':         'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          reject(new Error('KYC2020 response not JSON: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('KYC2020 request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── SCREEN INDIVIDUAL ─────────────────────────────────────────────────────────
// POST /screen — screens name + DOB + address against all lists

async function screenIndividual({ firstName, lastName, dob, address, city, province, postal, country = 'CA' }) {
  if (!isConfigured()) {
    return { status: 'skipped', reason: 'KYC screening not enabled or not configured' };
  }

  console.log(`[kyc] Screening ${firstName} ${lastName} DOB:${dob}`);

  try {
    const { status, body } = await kycRequest('/screen', {
      type:      'individual',
      firstName,
      lastName,
      dob,
      address: {
        street:   address,
        city,
        province,
        postal,
        country,
      },
      // Screen against all relevant lists for Canadian lenders
      lists: ['sanctions', 'pep', 'rca', 'adverse_media'],
      threshold: 85, // Match confidence threshold (85% = strict, fewer false positives)
    });

    if (status !== 200) {
      console.error('[kyc] API error:', status, JSON.stringify(body).slice(0, 200));
      return { status: 'error', reason: `API returned HTTP ${status}`, raw: body };
    }

    return parseScreenResult(body);
  } catch (err) {
    console.error('[kyc] Screen error:', err.message);
    return { status: 'error', reason: err.message };
  }
}

// ── PARSE RESULT ──────────────────────────────────────────────────────────────

function parseScreenResult(raw) {
  // KYC2020 response structure (based on their API docs)
  const matches   = raw.matches || raw.results || [];
  const hasMatch  = matches.length > 0;
  const highRisk  = matches.some(m => (m.score || m.confidence || 0) >= 90);
  const lists     = [...new Set(matches.map(m => m.list || m.listType || '?'))];

  const status = !hasMatch ? 'clear'
    : highRisk              ? 'flag'
    :                         'review'; // Low-confidence match — needs manual review

  const summary = hasMatch
    ? `${matches.length} match${matches.length !== 1 ? 'es' : ''} found on: ${lists.join(', ')}`
    : 'No matches found';

  // Build structured result for storage
  const result = {
    status,
    summary,
    matchCount:  matches.length,
    lists:       lists,
    highRisk,
    matches:     matches.slice(0, 5).map(m => ({
      name:       m.name || m.fullName,
      list:       m.list || m.listType,
      score:      m.score || m.confidence,
      matchType:  m.matchType || m.type,
      details:    m.details || m.description,
    })),
    checkedAt:   new Date().toISOString(),
    raw:         raw,
  };

  console.log(`[kyc] Result: ${status} — ${summary}`);
  return result;
}

// ── RISK LEVEL LABEL ─────────────────────────────────────────────────────────

function getRiskLabel(kycStatus) {
  return {
    clear:   { label: '✓ Clear',        color: '#00D4AA', badge: 'kyc-clear'  },
    review:  { label: '⚠ Review',       color: '#F5A623', badge: 'kyc-review' },
    flag:    { label: '🚨 Flagged',      color: '#FF5C73', badge: 'kyc-flag'   },
    pending: { label: '⏳ Pending',      color: '#A29BFE', badge: 'kyc-pending'},
    skipped: { label: '— Not Screened', color: '#6b7db3', badge: 'kyc-skip'   },
    error:   { label: '⚠ Error',        color: '#F5A623', badge: 'kyc-error'  },
  }[kycStatus] || { label: '—', color: '#6b7db3', badge: '' };
}

module.exports = { isConfigured, getStatus, screenIndividual, getRiskLabel };
