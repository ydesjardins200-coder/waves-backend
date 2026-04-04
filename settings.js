'use strict';

/**
 * Waves Financial — Settings Store
 *
 * Persists admin toggle settings (payment processor, IBV provider, KYC enabled)
 * to a `system_settings` table in Supabase so they survive Railway restarts
 * and work consistently across all sessions/browsers.
 *
 * SQL to create the table (run once in Supabase SQL Editor):
 *
 *   create table if not exists public.system_settings (
 *     key   text primary key,
 *     value text not null,
 *     updated_at timestamptz default now()
 *   );
 *   insert into public.system_settings (key, value) values
 *     ('payment_processor', 'manual'),
 *     ('ibv_provider',      'flinks'),
 *     ('kyc_enabled',       'false')
 *   on conflict (key) do nothing;
 */

const { supabase } = require('./supabaseClient');

// In-memory cache — loaded on startup, updated on every set()
const cache = {
  payment_processor: process.env.PAYMENT_PROCESSOR || 'manual',
  ibv_provider:      process.env.IBV_PROVIDER      || 'flinks',
  kyc_enabled:       process.env.KYC_ENABLED        || 'false',
  payment_methods:   null, // loaded from DB; null = use code defaults
};

let loaded = false;

// ── LOAD FROM SUPABASE ────────────────────────────────────────────────────────
// Called once at startup — populates cache from DB, overriding env var defaults

async function load() {
  if (!supabase) { console.warn('[settings] No Supabase client — using env var defaults'); loaded = true; return; }
  try {
    const { data, error } = await supabase.from('system_settings').select('key, value');
    if (error) throw new Error(error.message);
    if (data?.length) {
      for (const row of data) {
        if (row.value !== null && row.value !== undefined) {
          cache[row.key] = row.value;
        }
      }
      console.log('[settings] Loaded from Supabase:', Object.keys(cache).filter(k => cache[k] !== null).join(', '));
    } else {
      console.log('[settings] No settings in DB yet — seeding defaults');
      await seedDefaults();
    }
  } catch (err) {
    console.error('[settings] Load error (using env defaults):', err.message);
  }
  loaded = true;
}

async function seedDefaults() {
  if (!supabase) return;
  const rows = Object.entries(cache).map(([key, value]) => ({ key, value }));
  await supabase.from('system_settings').upsert(rows, { onConflict: 'key', ignoreDuplicates: true });
}

// ── GET ───────────────────────────────────────────────────────────────────────

function get(key) {
  return cache[key] ?? null;
}

function getAll() {
  return { ...cache };
}

// ── SET ───────────────────────────────────────────────────────────────────────
// Updates in-memory cache immediately + persists to Supabase

async function set(key, value) {
  cache[key] = value;
  if (!supabase) return;
  const { error } = await supabase.from('system_settings').upsert(
    { key, value, updated_at: new Date().toISOString() },
    { onConflict: 'key' }
  );
  if (error) console.error(`[settings] Failed to persist ${key}=${value}:`, error.message);
  else console.log(`[settings] Saved ${key}=${value}`);
}

// ── TYPED GETTERS ─────────────────────────────────────────────────────────────

function getProcessor()  { return get('payment_processor') || 'manual'; }
function getIBVProvider(){ return get('ibv_provider')      || 'flinks'; }
function isKYCEnabled()  { return get('kyc_enabled') === 'true'; }

function waitUntilLoaded() {
  if (loaded) return Promise.resolve();
  return new Promise(resolve => {
    const iv = setInterval(() => { if (loaded) { clearInterval(iv); resolve(); } }, 20);
  });
}

module.exports = { load, get, set, getAll, getProcessor, getIBVProvider, isKYCEnabled, waitUntilLoaded, getLoanSettings };

// ── LOAN SETTINGS HELPERS ─────────────────────────────────────────────────────
const ALL_PROVINCES = ['BC','ON','NS','NB','PE','NL','AB','MB','SK','QC','YT','NT','NU'];
const DEFAULT_SERVED = ['BC','ON','NS','NB','PE','NL'];

function getLoanSettings() {
  const rawProvinces = get('served_provinces');
  const servedProvinces = rawProvinces
    ? JSON.parse(rawProvinces)
    : DEFAULT_SERVED;
  return {
    minLoan:        parseFloat(get('min_loan')      || 500),
    maxLoan:        parseFloat(get('max_loan')      || 1000),
    apr:            parseFloat(get('apr')           || 0.23),
    termDays:       parseInt(  get('term_days')     || 112),
    paymentCount:   parseInt(  get('payment_count') || 8),
    nsfFee:         parseFloat(get('nsf_fee')       || 45.00),
    padCutoffTime:  get('pad_cutoff_time')          || '14:30',
    emailNotif:     get('email_notifications')      === 'true',
    servedProvinces,
    allProvinces:   ALL_PROVINCES,
  };
}

module.exports.DEFAULT_SERVED = DEFAULT_SERVED;
