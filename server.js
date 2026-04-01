'use strict';

/**
 * Waves Financial — Backend Server
 *
 * Endpoints:
 *   POST /api/apply/new      — New loan application
 *   POST /api/apply/renewal  — Loan renewal application
 *   GET  /health             — Health check
 */

const http    = require('http');
const { resolveApplication } = require('./decisionResolver');

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const PORT            = process.env.PORT || 3000;
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// In development, allow localhost origins automatically
if (process.env.NODE_ENV !== 'production') {
  ALLOWED_ORIGINS.push('http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:8888');
}


// ─── HELPERS ──────────────────────────────────────────────────────────────────

function setCORSHeaders(req, res) {
  const origin = req.headers['origin'];
  if (origin && (ALLOWED_ORIGINS.includes(origin) || process.env.NODE_ENV !== 'production')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// Graceful fallback response — never let the applicant see a broken experience
function fallbackResponse(ref) {
  return {
    ref,
    decision:       'manual_review',
    tier:           'green',
    score:          null,
    approvedAmount: null,
    message:        'Your application is under review.',
    nextSteps: [
      'Our team will review your application during business hours.',
      'You will receive an email with our decision shortly.',
    ],
  };
}

// Validate that the minimum required fields are present
function validatePayload(body, type) {
  const errors = [];

  if (!body?.personal?.firstName)  errors.push('personal.firstName is required');
  if (!body?.personal?.lastName)   errors.push('personal.lastName is required');
  if (!body?.personal?.email)      errors.push('personal.email is required');
  if (!body?.loan?.amount)         errors.push('loan.amount is required');
  if (!body?.banking?.flinksLoginId) errors.push('banking.flinksLoginId is required');

  if (type === 'new') {
    if (!body?.employment?.payFrequency) errors.push('employment.payFrequency is required');
    if (!body?.employment?.nextPay)      errors.push('employment.nextPay is required');
  }

  return errors;
}

// Generate a reference number: WF-XXXXXX
function generateRef() {
  return 'WF-' + Math.random().toString(36).slice(2, 8).toUpperCase();
}


// ─── REQUEST HANDLER ──────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  setCORSHeaders(req, res);

  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (req.method === 'GET' && req.url === '/health') {
    sendJSON(res, 200, {
      status: 'ok',
      env:    process.env.NODE_ENV || 'development',
      time:   new Date().toISOString(),
    });
    return;
  }

  // ── POST /api/apply/new ─────────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/apply/new') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid request body' });
      return;
    }

    // Attach ref and timestamp if not present
    body.ref         = body.ref || generateRef();
    body.submittedAt = body.submittedAt || new Date().toISOString();
    body.type        = 'new';

    // Validate
    const errors = validatePayload(body, 'new');
    if (errors.length) {
      sendJSON(res, 422, { error: 'Validation failed', details: errors });
      return;
    }

    console.log(`[new] ${body.ref} — ${body.personal.firstName} ${body.personal.lastName} — $${body.loan.amount}`);

    try {
      const decision = await resolveApplication(body);
      console.log(`[new] ${body.ref} → ${decision.decision} (tier: ${decision.tier}, score: ${decision.score})`);
      sendJSON(res, 200, decision);
    } catch (err) {
      console.error(`[new] ${body.ref} pipeline error:`, err.message);
      sendJSON(res, 200, fallbackResponse(body.ref));
    }
    return;
  }

  // ── POST /api/apply/renewal ─────────────────────────────────────────────────
  if (req.method === 'POST' && req.url === '/api/apply/renewal') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      sendJSON(res, 400, { error: 'Invalid request body' });
      return;
    }

    body.ref         = body.ref || generateRef();
    body.submittedAt = body.submittedAt || new Date().toISOString();
    body.type        = 'renewal';

    const errors = validatePayload(body, 'renewal');
    if (errors.length) {
      sendJSON(res, 422, { error: 'Validation failed', details: errors });
      return;
    }

    console.log(`[renewal] ${body.ref} — ${body.personal.firstName} ${body.personal.lastName} — $${body.loan.amount}`);

    try {
      const decision = await resolveApplication(body);
      console.log(`[renewal] ${body.ref} → ${decision.decision} (tier: ${decision.tier}, score: ${decision.score})`);
      sendJSON(res, 200, decision);
    } catch (err) {
      console.error(`[renewal] ${body.ref} pipeline error:`, err.message);
      sendJSON(res, 200, fallbackResponse(body.ref));
    }
    return;
  }

  // 404 for everything else
  sendJSON(res, 404, { error: 'Not found' });
}


// ─── START ────────────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n✅ Waves Financial backend running on port ${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Health:      http://localhost:${PORT}/health`);
  console.log(`   New loan:    POST http://localhost:${PORT}/api/apply/new`);
  console.log(`   Renewal:     POST http://localhost:${PORT}/api/apply/renewal\n`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received — shutting down gracefully');
  server.close(() => process.exit(0));
});
process.on('SIGINT', () => {
  console.log('SIGINT received — shutting down gracefully');
  server.close(() => process.exit(0));
});
