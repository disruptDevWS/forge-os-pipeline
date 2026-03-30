/**
 * google-auth.ts — Google auth utility for GSC + GA4 integration.
 *
 * Uses Application Default Credentials (ADC) + service account impersonation.
 * No SA JSON key needed — compliant with org policy iam.disableServiceAccountKeyCreation.
 *
 * Auth flow:
 *   1. Load ADC credentials (user refresh token from `gcloud auth application-default login`)
 *   2. Exchange refresh token for user access token
 *   3. Impersonate service account via IAM Credentials API (generateAccessToken)
 *   4. Return scoped SA access token for GSC/GA4 API calls
 *
 * Credential sources (checked in order):
 *   - GOOGLE_ADC_JSON env var (Railway: stringified ADC credentials JSON)
 *   - GOOGLE_APPLICATION_CREDENTIALS file path
 *   - Default ADC path: ~/.config/gcloud/application_default_credentials.json
 *
 * Service account: fg-analytics@concise-vertex-490015-d0.iam.gserviceaccount.com
 * Requires: roles/iam.serviceAccountTokenCreator on the ADC identity
 *
 * Exports:
 *   getServiceAccountAccessToken(scopes) — cached Google access token (impersonated SA)
 *   getAnalyticsConnection(sb, auditId) — property IDs from analytics_connections
 */

import { SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ============================================================
// Constants
// ============================================================

const SERVICE_ACCOUNT_EMAIL =
  'fg-analytics@concise-vertex-490015-d0.iam.gserviceaccount.com';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const IAM_CREDENTIALS_ENDPOINT =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

// ============================================================
// Types
// ============================================================

interface AdcCredentials {
  client_id: string;
  client_secret: string;
  refresh_token: string;
  type: 'authorized_user';
}

export interface AnalyticsConnection {
  id: string;
  audit_id: string;
  domain: string;
  gsc_property_url: string | null;
  ga4_property_id: string | null;
  last_gsc_sync_at: string | null;
  last_ga4_sync_at: string | null;
}

// ============================================================
// Token caches
// ============================================================

let cachedUserToken: { token: string; expiresAt: number } | null = null;
let cachedSaToken: { token: string; expiresAt: number; scopeKey: string } | null = null;

// ============================================================
// ADC credential loading
// ============================================================

function loadAdcCredentials(): AdcCredentials {
  // 1. GOOGLE_ADC_JSON env var (Railway deployment — stringified JSON)
  const adcJson = process.env.GOOGLE_ADC_JSON;
  if (adcJson) {
    try {
      const parsed = JSON.parse(adcJson);
      validateAdcCredentials(parsed, 'GOOGLE_ADC_JSON');
      return parsed;
    } catch (err: any) {
      if (err.message.includes('GOOGLE_ADC_JSON')) throw err;
      throw new Error(`Failed to parse GOOGLE_ADC_JSON: ${err.message}`);
    }
  }

  // 2. GOOGLE_APPLICATION_CREDENTIALS file path
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    return loadAdcFromFile(credPath, 'GOOGLE_APPLICATION_CREDENTIALS');
  }

  // 3. Default ADC path (~/.config/gcloud/application_default_credentials.json)
  const defaultPath = path.join(
    os.homedir(),
    '.config',
    'gcloud',
    'application_default_credentials.json',
  );
  if (fs.existsSync(defaultPath)) {
    return loadAdcFromFile(defaultPath, 'default ADC path');
  }

  throw new Error(
    'No Google ADC credentials found. Set GOOGLE_ADC_JSON (Railway), ' +
      'GOOGLE_APPLICATION_CREDENTIALS, or run `gcloud auth application-default login`.',
  );
}

function loadAdcFromFile(filePath: string, label: string): AdcCredentials {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    validateAdcCredentials(parsed, label);
    return parsed;
  } catch (err: any) {
    if (err.message.includes(label)) throw err;
    throw new Error(`Failed to load credentials from ${label} (${filePath}): ${err.message}`);
  }
}

function validateAdcCredentials(parsed: any, label: string): asserts parsed is AdcCredentials {
  if (parsed.type !== 'authorized_user') {
    throw new Error(
      `${label} has type "${parsed.type}" — expected "authorized_user". ` +
        'Run `gcloud auth application-default login` to generate user ADC credentials.',
    );
  }
  if (!parsed.client_id || !parsed.client_secret || !parsed.refresh_token) {
    throw new Error(`${label} missing client_id, client_secret, or refresh_token.`);
  }
}

// ============================================================
// User access token (from ADC refresh token)
// ============================================================

async function getUserAccessToken(): Promise<string> {
  // Return cached token if still valid (60s buffer)
  if (cachedUserToken && cachedUserToken.expiresAt > Date.now() + 60_000) {
    return cachedUserToken.token;
  }

  const creds = loadAdcCredentials();

  const resp = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    }).toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`ADC token refresh failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const token = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 3600;

  cachedUserToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return token;
}

// ============================================================
// SA impersonation (IAM Credentials API)
// ============================================================

async function impersonateServiceAccount(
  userToken: string,
  scopes: string[],
): Promise<{ token: string; expireTime: string }> {
  const url = `${IAM_CREDENTIALS_ENDPOINT}/${SERVICE_ACCOUNT_EMAIL}:generateAccessToken`;

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${userToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      scope: scopes,
      lifetime: '3600s',
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `SA impersonation failed (${resp.status}): ${errText}\n` +
        `Ensure the ADC identity has roles/iam.serviceAccountTokenCreator on ${SERVICE_ACCOUNT_EMAIL}.`,
    );
  }

  const data = await resp.json();
  return {
    token: data.accessToken as string,
    expireTime: data.expireTime as string,
  };
}

// ============================================================
// Public: scoped SA access token (cached)
// ============================================================

/**
 * Get a Google access token for the service account with the given scopes.
 * Uses ADC + impersonation (no SA key file needed).
 * Caches the token in-memory with a 5-minute refresh buffer.
 */
export async function getServiceAccountAccessToken(scopes: string[]): Promise<string> {
  const scopeKey = scopes.sort().join(',');

  // Return cached token if still valid (300s buffer) and same scopes
  if (
    cachedSaToken &&
    cachedSaToken.scopeKey === scopeKey &&
    cachedSaToken.expiresAt > Date.now() + 300_000
  ) {
    return cachedSaToken.token;
  }

  // Step 1: Get user access token from ADC
  const userToken = await getUserAccessToken();

  // Step 2: Impersonate the service account
  const result = await impersonateServiceAccount(userToken, scopes);

  // Parse expiry
  const expiresAt = new Date(result.expireTime).getTime();

  cachedSaToken = {
    token: result.token,
    expiresAt,
    scopeKey,
  };

  return result.token;
}

// ============================================================
// Analytics connection lookup
// ============================================================

/**
 * Get the analytics connection for an audit (GSC/GA4 property IDs).
 * Returns null if no active connection exists.
 */
export async function getAnalyticsConnection(
  sb: SupabaseClient,
  auditId: string,
): Promise<AnalyticsConnection | null> {
  const { data, error } = await (sb as any)
    .from('analytics_connections')
    .select('id, audit_id, domain, gsc_property_url, ga4_property_id, last_gsc_sync_at, last_ga4_sync_at')
    .eq('audit_id', auditId)
    .eq('status', 'active')
    .maybeSingle();

  if (error) {
    console.warn(`  [google-auth] Failed to query analytics_connections: ${error.message}`);
    return null;
  }

  return data as AnalyticsConnection | null;
}
