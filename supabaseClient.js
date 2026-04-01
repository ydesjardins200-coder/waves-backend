'use strict';

/**
 * Waves Financial — Supabase Client
 *
 * Single shared client instance used by all modules.
 * Reads credentials from environment variables.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL     = process.env.SUPABASE_URL;
const SUPABASE_API_KEY = process.env.SUPABASE_API_KEY; // use service_role key (server-side only)

if (!SUPABASE_URL || !SUPABASE_API_KEY) {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_API_KEY not set — database writes will be skipped.');
}

const supabase = (SUPABASE_URL && SUPABASE_API_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_API_KEY, {
      auth: { persistSession: false }, // server-side — no session storage
    })
  : null;

module.exports = { supabase };
