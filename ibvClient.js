'use strict';

/**
 * Waves Financial — IBV (Instant Bank Verification) Router
 *
 * Abstracts between Flinks and VoPay iQ11.
 * Active provider controlled by IBV_PROVIDER env var ('flinks' | 'vopay')
 *
 * VoPay iQ11 docs: https://docs.vopay.com/docs/iq11-overview
 * Flow:
 *   1. Frontend calls GET /api/ibv/embed-url
 *   2. Backend calls iq11/generate-embed-url → returns iFrame URL
 *   3. Frontend embeds URL in iFrame
 *   4. User logs into bank → VoPay fires postMessage with token
 *   5. Frontend sends token to backend with application payload
 *   6. Backend stores token on client record for future collections
 */

const https = require('https');

const IBV_PROVIDER     = process.env.IBV_PROVIDER      || 'flinks'; // 'flinks' | 'vopay'
const VOPAY_BASE_URL   = process.env.VOPAY_BASE_URL     || 'https://earthnode-dev.vopay.com';
const VOPAY_ACCOUNT_ID = process.env.VOPAY_ACCOUNT_ID  || null;
const VOPAY_API_KEY    = process.env.VOPAY_API_KEY      || null;
const VOPAY_API_SECRET = process.env.VOPAY_API_SECRET   || null;
const FLINKS_CLIENT_ID = process.env.FLINKS_CLIENT_ID   || 'YOUR_FLINKS_CLIENT_ID';

// The redirect URL VoPay sends the user back to after bank auth
// Using JavascriptMessage so no redirect needed — token comes via postMessage
const IQ11_REDIRECT_URL = process.env.IQ11_REDIRECT_URL || 'https://wavesfinancial.ca/apply.html';

function getProvider() { return IBV_PROVIDER; }
function isVoPay()     { return IBV_PROVIDER === 'vopay'; }
function isFlinks()    { return IBV_PROVIDER === 'flinks'; }

function isVoPayConfigured() {
  return !!(VOPAY_ACCOUNT_ID && VOPAY_API_KEY && VOPAY_API_SECRET);
}

function getStatus() {
  return {
    provider:         IBV_PROVIDER,
    flinksClientId:   FLINKS_CLIENT_ID !== 'YOUR_FLINKS_CLIENT_ID' ? FLINKS_CLIENT_ID.slice(0,8)+'…' : null,
    vopayConfigured:  isVoPayConfigured(),
    vopayBaseUrl:     VOPAY_BASE_URL,
  };
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function vopayPost(path, params = {}) {
  return new Promise((resolve, reject) => {
    const payload = {
      AccountID: VOPAY_ACCOUNT_ID,
      Key:       VOPAY_API_KEY,
      Signature: VOPAY_API_SECRET,
      ...params,
    };
    const body    = new URLSearchParams(payload).toString();
    const url     = new URL(VOPAY_BASE_URL + path);
    const options = {
      hostname: url.hostname,
      path:     url.pathname,
      port:     443,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept':         'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Success === '0' || json.Success === false) {
            reject(new Error('VoPay iQ11 error: ' + (json.ErrorMessage || JSON.stringify(json))));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error('VoPay response not JSON: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('VoPay iQ11 timed out')); });
    req.write(body);
    req.end();
  });
}

// ── GENERATE EMBED URL (iQ11 only) ────────────────────────────────────────────
// Returns the iFrame URL to embed in apply.html / client.html

async function generateEmbedUrl({ redirectUrl, language = 'en-CA', companyName = 'Waves Financial' } = {}) {
  if (!isVoPayConfigured()) {
    throw new Error('VoPay credentials not configured');
  }

  const result = await vopayPost('/api/v2/account/iq11/generate-embed-url', {
    RedirectURL:    redirectUrl || IQ11_REDIRECT_URL,
    RedirectMethod: 'JavascriptMessage', // postMessage — no page redirect
    Language:       language,
    CompanyName:    companyName,
  });

  return {
    embedUrl:   result.EmbedURL || result.iFrameUrl,
    requestId:  result.RequestID,
    expiresAt:  result.ExpiresAt,
  };
}

// ── FLINKS EMBED URL ──────────────────────────────────────────────────────────

function getFlinksEmbedUrl() {
  if (FLINKS_CLIENT_ID === 'YOUR_FLINKS_CLIENT_ID') {
    return null; // Not configured — use sandbox simulation
  }
  return `https://${FLINKS_CLIENT_ID}-iframe.private.fin.ag/v2/?redirectUrl=https://wavesfinancial.ca/apply.html&innerRedirect=true&demo=false&institutionFilterEnable=false&consentEnable=false&customerName=Waves Financial`;
}

// ── PROVIDER INFO FOR FRONTEND ────────────────────────────────────────────────
// Returns what the frontend needs to render the correct IBV widget

async function getEmbedConfig({ redirectUrl } = {}) {
  if (isVoPay()) {
    if (!isVoPayConfigured()) {
      // Fall back to Flinks if VoPay not yet configured
      return { provider: 'flinks', flinksUrl: getFlinksEmbedUrl(), fallback: true };
    }
    try {
      const { embedUrl } = await generateEmbedUrl({ redirectUrl });
      return { provider: 'vopay', embedUrl };
    } catch (err) {
      console.error('[ibv] iQ11 embed URL error:', err.message);
      return { provider: 'flinks', flinksUrl: getFlinksEmbedUrl(), fallback: true, error: err.message };
    }
  }

  // Flinks
  return { provider: 'flinks', flinksUrl: getFlinksEmbedUrl() };
}

module.exports = { getProvider, isVoPay, isFlinks, isVoPayConfigured, getStatus, generateEmbedUrl, getFlinksEmbedUrl, getEmbedConfig };
