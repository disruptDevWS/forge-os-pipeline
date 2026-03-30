/**
 * google-auth.ts — Service account auth utility for GSC + GA4 integration.
 *
 * Uses JWT signing with Node.js built-in crypto (no googleapis package).
 * Service account: fg-analytics@concise-vertex-490015-d0.iam.gserviceaccount.com
 *
 * Exports:
 *   getServiceAccountAccessToken(scopes) — cached Google access token
 *   getAnalyticsConnection(sb, auditId) — property IDs from analytics_connections
 */

import * as crypto from 'node:crypto';
import { SupabaseClient } from '@supabase/supabase-js';
import * as fs from 'node:fs';

// ============================================================
// Types
// ============================================================

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri: string;
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
// Token cache
// ============================================================

let cachedToken: { token: string; expiresAt: number } | null = null;

// ============================================================
// Service account key loading
// ============================================================

function loadServiceAccountKey(): ServiceAccountKey {
  // Primary: GOOGLE_SERVICE_ACCOUNT_JSON env var (stringified JSON)
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key');
      }
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
      };
    } catch (err: any) {
      throw new Error(`Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON: ${err.message}`);
    }
  }

  // Fallback: GOOGLE_APPLICATION_CREDENTIALS file path (local dev)
  const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credPath) {
    try {
      const content = fs.readFileSync(credPath, 'utf-8');
      const parsed = JSON.parse(content);
      if (!parsed.client_email || !parsed.private_key) {
        throw new Error('Credentials file missing client_email or private_key');
      }
      return {
        client_email: parsed.client_email,
        private_key: parsed.private_key,
        token_uri: parsed.token_uri || 'https://oauth2.googleapis.com/token',
      };
    } catch (err: any) {
      throw new Error(`Failed to load GOOGLE_APPLICATION_CREDENTIALS (${credPath}): ${err.message}`);
    }
  }

  throw new Error(
    'No Google service account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON (Railway) or GOOGLE_APPLICATION_CREDENTIALS (local dev).',
  );
}

// ============================================================
// JWT creation + signing
// ============================================================

function createSignedJwt(key: ServiceAccountKey, scopes: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600; // 1 hour

  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: key.client_email,
    scope: scopes.join(' '),
    aud: key.token_uri,
    iat: now,
    exp,
  };

  const encode = (obj: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(obj)).toString('base64url');

  const headerB64 = encode(header);
  const payloadB64 = encode(payload);
  const signingInput = `${headerB64}.${payloadB64}`;

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(signingInput);
  const signature = sign.sign(key.private_key, 'base64url');

  return `${signingInput}.${signature}`;
}

// ============================================================
// Access token retrieval (cached)
// ============================================================

/**
 * Get a Google access token for the service account with the given scopes.
 * Caches the token in-memory with a 5-minute refresh buffer.
 */
export async function getServiceAccountAccessToken(scopes: string[]): Promise<string> {
  // Return cached token if still valid (300s buffer)
  if (cachedToken && cachedToken.expiresAt > Date.now() + 300_000) {
    return cachedToken.token;
  }

  const key = loadServiceAccountKey();
  const jwt = createSignedJwt(key, scopes);

  const resp = await fetch(key.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Google token exchange failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  const token = data.access_token as string;
  const expiresIn = (data.expires_in as number) || 3600;

  cachedToken = {
    token,
    expiresAt: Date.now() + expiresIn * 1000,
  };

  return token;
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
