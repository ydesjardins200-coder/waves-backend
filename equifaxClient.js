'use strict';

/**
 * Waves Financial — Equifax OneView Integration
 *
 * Server-side only. Credentials never exposed to the browser.
 * 
 * Flow:
 *   1. Exchange Client ID + Secret for OAuth token (24-min expiry)
 *   2. POST consumer credit file request with token
 *   3. Parse and return a simplified score/factors payload to client.html
 *
 * Environments:
 *   Sandbox: api.equifax.com  — static test data, any request body works
 *   Test:    api.equifax.com  — real test cases, promoted from sandbox
 *   Live:    api.equifax.com  — production, IP-whitelisted
 */

const https = require('https');

const EFX_CLIENT_ID     = process.env.EQUIFAX_CLIENT_ID;
const EFX_CLIENT_SECRET = process.env.EQUIFAX_CLIENT_SECRET;
const EFX_TOKEN_URL     = process.env.EQUIFAX_TOKEN_URL  || 'https://api.equifax.com/v2/oauth/token';
const EFX_REPORT_URL    = process.env.EQUIFAX_REPORT_URL || 'https://api.equifax.com/business/oneview/consumer-credit/v1/report';
const EFX_SCOPE         = process.env.EQUIFAX_SCOPE      || 'https://api.equifax.com/business/oneview/consumer-credit/v1';

// Simple in-memory token cache (token expires in 24 min, we cache for 20)
let _cachedToken = null;
let _tokenExpiry = 0;

// ─── HTTP HELPER ──────────────────────────────────────────────────────────────

function httpsRequest(url, options, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      path:     parsed.pathname + (parsed.search || ''),
      port:     443,
      method:   options.method || 'GET',
      headers:  options.headers || {},
    };

    const req = https.request(reqOpts, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ status: res.statusCode, headers: res.headers, body: data });
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timed out')); });

    if (body) req.write(body);
    req.end();
  });
}

// ─── TOKEN EXCHANGE ───────────────────────────────────────────────────────────

async function getAccessToken() {
  // Return cached token if still valid
  if (_cachedToken && Date.now() < _tokenExpiry) {
    return _cachedToken;
  }

  if (!EFX_CLIENT_ID || !EFX_CLIENT_SECRET) {
    throw new Error('EQUIFAX_CLIENT_ID and EQUIFAX_CLIENT_SECRET env vars not set');
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    client_id:     EFX_CLIENT_ID,
    client_secret: EFX_CLIENT_SECRET,
    scope:         EFX_SCOPE,
  }).toString();

  // Try token URL from env first, then common Equifax patterns
  const tokenUrls = [
    EFX_TOKEN_URL,
    'https://api.equifax.com/v2/oauth/token',
    'https://api.equifax.com/oauth/token',
    'https://api.equifax.com/v1/oauth/token',
  ].filter((v, i, a) => v && a.indexOf(v) === i); // dedupe

  let lastError = null;

  for (const tokenUrl of tokenUrls) {
    try {
      const res = await httpsRequest(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type':   'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          'Accept':         'application/json',
        },
      }, body);

      console.log(`[equifax] Token attempt ${tokenUrl} → HTTP ${res.status} — ${res.body.slice(0, 200)}`);

      if (res.status === 200) {
        let parsed;
        try { parsed = JSON.parse(res.body); }
        catch { throw new Error('Token response not JSON: ' + res.body.slice(0, 200)); }

        _cachedToken = parsed.access_token;
        _tokenExpiry = Date.now() + 20 * 60 * 1000;
        console.log(`[equifax] Token obtained from ${tokenUrl}`);
        return _cachedToken;
      }

      lastError = new Error(`HTTP ${res.status} from ${tokenUrl} — ${res.body.slice(0, 300)}`);
    } catch (err) {
      lastError = err;
      console.warn(`[equifax] Token URL failed: ${tokenUrl} — ${err.message}`);
    }
  }

  throw lastError || new Error('All Equifax token URLs failed');
}

// ─── CREDIT REPORT REQUEST ────────────────────────────────────────────────────

async function fetchCreditReport({ firstName, lastName, dob, address, city, province, postal }) {
  const token = await getAccessToken();

  // CPA / Equifax Canada request body
  // In sandbox: static response regardless of input
  const requestBody = JSON.stringify({
    consumers: {
      name: [{
        identifier: 'current',
        firstName:  firstName  || 'John',
        lastName:   lastName   || 'Smith',
      }],
      socialNum: [],   // SIN optional — not collecting from client portal
      dateOfBirth: dob ? [{ identifier: 'current', dob }] : [],
      addresses: [{
        identifier: 'current',
        street:     address  || '123 Main St',
        city:       city     || 'Toronto',
        state:      province || 'ON',
        zip:        (postal  || 'M5V1A1').replace(/\s/g, ''),
        countryCode: 'CA',
      }],
    },
    addOns: {
      equifaxUSConsumerCreditReport: [],
    },
  });

  const res = await httpsRequest(EFX_REPORT_URL, {
    method: 'POST',
    headers: {
      'Authorization':  `Bearer ${token}`,
      'Content-Type':   'application/json',
      'Accept':         'application/json',
      'Content-Length': Buffer.byteLength(requestBody),
    },
  }, requestBody);

  console.log(`[equifax] Report response: HTTP ${res.status}, body length ${res.body.length}`);

  if (res.status === 401) {
    // Token may have expired — clear cache and retry once
    _cachedToken = null; _tokenExpiry = 0;
    throw new Error('Equifax auth failed — token expired or invalid');
  }

  if (res.status !== 200 && res.status !== 201) {
    console.error('[equifax] Report error body:', res.body.slice(0, 500));
    throw new Error(`Equifax report request failed: HTTP ${res.status}`);
  }

  let report;
  try { report = JSON.parse(res.body); }
  catch { throw new Error('Equifax report response not JSON'); }

  return parseCreditReport(report);
}

// ─── RESPONSE PARSER ──────────────────────────────────────────────────────────

function parseCreditReport(raw) {
  try {
    // Navigate the Equifax JSON structure
    // Root: consumers.equifaxUSConsumerCreditReport[0]
    const consumer = raw?.consumers?.equifaxUSConsumerCreditReport?.[0] ||
                     raw?.consumers?.creditReport?.[0] ||
                     raw?.creditReport?.[0] ||
                     raw;

    // Score — Equifax Beacon score
    const scoreModel  = consumer?.scores?.[0] || consumer?.score;
    const rawScore    = parseInt(scoreModel?.score || scoreModel?.value || scoreModel?.riskScore || 0);
    const score       = isNaN(rawScore) ? null : rawScore;

    // Score factors / reason codes
    const factors = (consumer?.scores?.[0]?.scoreFactors ||
                     consumer?.scoreFactors ||
                     []).slice(0, 5).map(f => ({
      code:        f.code || f.reasonCode || '—',
      description: f.description || f.reason || f.factorText || 'See full report',
    }));

    // Trade summary (accounts)
    const trades      = consumer?.tradelines || consumer?.trades || [];
    const openTrades  = trades.filter(t => t.openOrClosed === 'O' || t.status === 'open');
    const totalTrades = trades.length;

    // Inquiries
    const inquiries = (consumer?.inquiries || []).length;

    // Public records
    const publicRecords = (consumer?.bankruptcies || consumer?.publicRecords || []).length;

    // Collections
    const collections = (consumer?.collections || []).length;

    // Payment history — derive from trades
    const lateCount = trades.filter(t =>
      (t.monthsReviewedCount || 0) > 0 &&
      (t.delinquencies30Days || 0) + (t.delinquencies60Days || 0) + (t.delinquencies90to180Days || 0) > 0
    ).length;

    // Utilization — total balance / total limit
    const totalBalance = trades.reduce((s, t) => s + parseFloat(t.balance || 0), 0);
    const totalLimit   = trades.reduce((s, t) => s + parseFloat(t.creditLimit || t.highBalance || 0), 0);
    const utilization  = totalLimit > 0 ? Math.round(totalBalance / totalLimit * 100) : null;

    // Oldest account age
    const oldestTrade = trades.reduce((oldest, t) => {
      const opened = t.openDate || t.dateOpened;
      if (!opened) return oldest;
      const d = new Date(opened);
      return (!oldest || d < oldest) ? d : oldest;
    }, null);
    const accountAgeYears = oldestTrade
      ? Math.floor((Date.now() - oldestTrade.getTime()) / (365.25 * 24 * 3600 * 1000))
      : null;

    // Grade
    const grade = score >= 760 ? 'Excellent'
      : score >= 725 ? 'Very Good'
      : score >= 690 ? 'Good'
      : score >= 650 ? 'Fair'
      : score >= 600 ? 'Poor'
      : score ? 'Very Poor' : '—';

    // Grade colour
    const gradeColor = score >= 760 ? '#00D4AA'
      : score >= 725 ? '#00B4D8'
      : score >= 690 ? '#1A6FFF'
      : score >= 650 ? '#F5A623'
      : '#FF5C73';

    return {
      score,
      grade,
      gradeColor,
      factors,
      summary: {
        openAccounts:    openTrades.length,
        totalAccounts:   totalTrades,
        inquiries,
        publicRecords,
        collections,
        latePayments:    lateCount,
        utilization,
        accountAgeYears,
        totalBalance,
        totalLimit,
      },
      // Factor bars for the UI (0-100 scale where higher = better)
      factorBars: {
        paymentHistory:  lateCount === 0 ? 95 : Math.max(20, 95 - lateCount * 15),
        utilization:     utilization !== null ? Math.max(10, 100 - utilization) : 50,
        accountAge:      accountAgeYears !== null ? Math.min(100, accountAgeYears * 8) : 50,
        creditMix:       Math.min(100, totalTrades * 12),
        newInquiries:    Math.max(10, 100 - inquiries * 20),
        publicRecords:   publicRecords === 0 ? 100 : Math.max(0, 100 - publicRecords * 40),
      },
      raw: raw, // Include full raw response for debugging
    };

  } catch (err) {
    console.error('[equifax] Parse error:', err.message);
    // Return a minimal valid object so the UI doesn't crash
    return {
      score: null,
      grade: '—',
      gradeColor: 'rgba(160,200,255,.5)',
      factors: [],
      summary: {},
      factorBars: { paymentHistory:0, utilization:0, accountAge:0, creditMix:0, newInquiries:0, publicRecords:0 },
      parseError: err.message,
      raw,
    };
  }
}

module.exports = { fetchCreditReport, getAccessToken };
