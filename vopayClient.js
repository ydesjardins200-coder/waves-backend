'use strict';

/**
 * Waves Financial — VoPay Payment Processor
 *
 * Wraps VoPay's EFT API as a drop-in replacement for the manual
 * DRD/PAD file system. Both processors share the same interface:
 *
 *   disburse(loan)          → send funds to borrower via Interac e-Transfer / EFT credit
 *   collect(payment)        → debit borrower account for scheduled payment
 *   cancelPayment(txId)     → cancel a pending EFT transaction
 *   getTransaction(txId)    → get status of a transaction
 *   getBalance()            → get Waves Financial VoPay account balance
 *
 * Env vars required (add to Railway when credentials arrive):
 *   VOPAY_ACCOUNT_ID        — from VoPay dashboard
 *   VOPAY_API_KEY           — from VoPay dashboard
 *   VOPAY_API_SECRET        — from VoPay dashboard
 *   VOPAY_BASE_URL          — https://earthnode-dev.vopay.com (sandbox)
 *                             https://api.vopay.com (production)
 *
 * Docs: https://docs.vopay.com
 */

const https = require('https');

const VOPAY_BASE_URL  = process.env.VOPAY_BASE_URL   || 'https://earthnode-dev.vopay.com';
const VOPAY_ACCOUNT_ID= process.env.VOPAY_ACCOUNT_ID || null;
const VOPAY_API_KEY   = process.env.VOPAY_API_KEY    || null;
const VOPAY_API_SECRET= process.env.VOPAY_API_SECRET || null;

// ── STATUS CHECK ──────────────────────────────────────────────────────────────

function isConfigured() {
  return !!(VOPAY_ACCOUNT_ID && VOPAY_API_KEY && VOPAY_API_SECRET);
}

function getStatus() {
  return {
    configured: isConfigured(),
    baseUrl:    VOPAY_BASE_URL,
    accountId:  VOPAY_ACCOUNT_ID ? VOPAY_ACCOUNT_ID.slice(0, 4) + '…' : null,
    sandbox:    VOPAY_BASE_URL.includes('earthnode-dev'),
  };
}

// ── HTTP HELPER ───────────────────────────────────────────────────────────────

function vopayRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    if (!isConfigured()) {
      return reject(new Error('VoPay credentials not configured'));
    }

    // All VoPay API calls include AccountID, Key, Signature
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
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept':        'application/json',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.Success === '0' || json.Success === false) {
            reject(new Error(`VoPay error: ${json.ErrorMessage || JSON.stringify(json)}`));
          } else {
            resolve(json);
          }
        } catch {
          reject(new Error('VoPay response not JSON: ' + data.slice(0, 200)));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(20000, () => { req.destroy(); reject(new Error('VoPay request timed out')); });
    req.write(body);
    req.end();
  });
}

// ── DISBURSEMENT (DRD equivalent) ─────────────────────────────────────────────
// Sends loan funds to borrower via Interac e-Transfer (preferred) or EFT credit

async function disburse({ loanId, loanRef, amount, email, firstName, lastName, bankToken, transit, institution, account }) {
  console.log(`[vopay] Disbursing ${amount} for loan ${loanRef}`);

  // Prefer Interac e-Transfer for speed; fall back to EFT credit
  if (email) {
    return await vopayRequest('/api/v2/account/eft/interac-etransfer/send', {
      Amount:            amount.toFixed(2),
      RecipientName:     `${firstName} ${lastName}`.trim(),
      RecipientEmail:    email,
      TransactionLabel:  `Waves Financial — Loan ${loanRef}`,
      ClientReferenceNumber: loanRef,
      Memo:              `Loan disbursement — ${loanRef}`,
    });
  }

  // EFT credit (withdraw = credit to external account)
  // Uses iQ11 token if available, otherwise raw banking coords
  const params = {
    Amount:              amount.toFixed(2),
    Currency:            'CAD',
    FirstName:           firstName,
    LastName:            lastName,
    ClientReferenceNumber: loanRef,
    Memo:                `Loan disbursement — ${loanRef}`,
  };

  if (bankToken) {
    params.Token = bankToken;
  } else {
    params.InstitutionNumber = institution;
    params.TransitNumber     = transit;
    params.AccountNumber     = account;
  }

  return await vopayRequest('/api/v2/account/eft/withdraw', params);
}

// ── COLLECTION (PAD equivalent) ───────────────────────────────────────────────
// Debits borrower account for a scheduled payment

async function collect({ paymentId, loanRef, amount, firstName, lastName, bankToken, transit, institution, account, dueDate }) {
  console.log(`[vopay] Collecting ${amount} for payment ${paymentId} (loan ${loanRef})`);

  const params = {
    Amount:              amount.toFixed(2),
    Currency:            'CAD',
    FirstName:           firstName,
    LastName:            lastName,
    ClientReferenceNumber: `${loanRef}-P${paymentId}`,
    Memo:                `Loan repayment — ${loanRef}`,
  };

  if (bankToken) {
    params.Token = bankToken;
  } else {
    params.InstitutionNumber = institution;
    params.TransitNumber     = transit;
    params.AccountNumber     = account;
  }

  // Schedule for due date if provided and in the future
  if (dueDate) {
    const due = new Date(dueDate);
    const now = new Date();
    if (due > now) {
      params.ScheduledDate = dueDate; // YYYY-MM-DD
    }
  }

  return await vopayRequest('/api/v2/account/eft/fund', params);
}

// ── CANCEL TRANSACTION ────────────────────────────────────────────────────────

async function cancelPayment(transactionId) {
  return await vopayRequest('/api/v2/account/eft/cancel-transaction', {
    TransactionID: transactionId,
  });
}

// ── TRANSACTION STATUS ────────────────────────────────────────────────────────

async function getTransaction(transactionId) {
  return await vopayRequest('/api/v2/account/eft/transaction', {
    TransactionID: transactionId,
  });
}

// ── ACCOUNT BALANCE ───────────────────────────────────────────────────────────

async function getBalance() {
  return await vopayRequest('/api/v2/account/balance');
}

// ── WEBHOOK PARSER ────────────────────────────────────────────────────────────
// Called when VoPay POSTs a return/NSF webhook to /api/vopay/webhook

function parseWebhook(body) {
  // VoPay webhook payload contains transaction status updates
  const type        = body.TransactionType || body.Type || '';
  const status      = body.Status          || '';
  const txId        = body.TransactionID   || '';
  const ref         = body.ClientReferenceNumber || '';
  const amount      = parseFloat(body.Amount || 0);
  const returnCode  = body.ReturnCode      || '';
  const returnMsg   = body.ReturnMessage   || '';

  const isNSF       = returnCode === '900' || status === 'Failed' || returnMsg.toLowerCase().includes('nsf');
  const isReturned  = status === 'Returned' || status === 'Failed' || status === 'Cancelled';
  const isCompleted = status === 'Completed' || status === 'Processed';

  return { type, status, txId, ref, amount, returnCode, returnMsg, isNSF, isReturned, isCompleted };
}

module.exports = {
  isConfigured,
  getStatus,
  disburse,
  collect,
  cancelPayment,
  getTransaction,
  getBalance,
  parseWebhook,
};
