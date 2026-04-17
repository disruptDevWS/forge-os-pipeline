/**
 * supabase.ts — Shared Supabase admin client (service_role, lazy-init).
 *
 * Follows the same singleton pattern as anthropic-client.ts getClient().
 * Scripts that create their own clients inline continue to do so;
 * this module serves src/ modules that need a shared client.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

let _client: SupabaseClient | null = null;

export function getSupabaseAdmin(): SupabaseClient {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
    }
    _client = createClient(url, key);
  }
  return _client;
}

/** Reset the singleton (for testing). */
export function _resetSupabaseAdmin(): void {
  _client = null;
}
