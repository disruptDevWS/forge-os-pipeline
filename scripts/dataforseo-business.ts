/**
 * dataforseo-business.ts — DataForSEO client for GBP lookup + SERP citation scan
 *
 * Auth: Basic auth from DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD.
 * Cost tracking: appends to audits/.dataforseo_cost.log.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const DATAFORSEO_API = 'https://api.dataforseo.com/v3';
const COST_LOG = path.resolve(process.cwd(), 'audits/.dataforseo_cost.log');

// ── Types ─────────────────────────────────────────────────────

export interface BusinessCredentials {
  login: string;
  password: string;
}

export interface GBPResult {
  listing_found: boolean;
  match_confidence: string | null;
  matched_name: string | null;
  category: string | null;
  additional_categories: string[];
  rating: number | null;
  review_count: number | null;
  photo_count: number | null;
  is_claimed: boolean | null;
  website_url: string | null;
  work_hours: Record<string, any> | null;
  attributes: Record<string, any> | null;
  canonical_name: string | null;
  canonical_address: string | null;
  canonical_phone: string | null;
  cid: string | null;
  place_id: string | null;
  gbp_missing: boolean;
  raw_response: Record<string, any> | null;
}

export interface CitationResult {
  directory_name: string;
  directory_domain: string;
  listing_found: boolean;
  listing_url: string | null;
  found_name: string | null;
  found_address: string | null;
  found_phone: string | null;
  nap_match_name: boolean | null;
  nap_match_address: boolean | null;
  nap_match_phone: boolean | null;
  nap_consistent: boolean | null;
  data_source: string;
  raw_snippet: string | null;
}

export interface CanonicalNAP {
  name: string | null;
  address: string | null;
  phone: string | null;
}

// US state abbreviation → full name (for DataForSEO location_name)
const STATE_NAMES: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi',
  MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire',
  NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina',
  ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee',
  TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington',
  WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia',
};

/** Expand state abbreviation to full name, pass through if already full */
export function expandState(state: string): string {
  const upper = state.trim().toUpperCase();
  return STATE_NAMES[upper] ?? state;
}

// 10 SERP-scanned directories + Google (synthesized from GBP)
export const CITATION_DIRECTORIES: Array<{ name: string; domain: string }> = [
  { name: 'Apple Maps', domain: 'maps.apple.com' },
  { name: 'Bing Places', domain: 'bing.com' },
  { name: 'Facebook', domain: 'facebook.com' },
  { name: 'Yelp', domain: 'yelp.com' },
  { name: 'BBB', domain: 'bbb.org' },
  { name: 'Angi', domain: 'angi.com' },
  { name: 'Thumbtack', domain: 'thumbtack.com' },
  { name: 'Foursquare', domain: 'foursquare.com' },
  { name: 'Yellow Pages', domain: 'yellowpages.com' },
  { name: 'Manta', domain: 'manta.com' },
];

// ── Auth helpers ──────────────────────────────────────────────

function makeAuthHeader(creds: BusinessCredentials): string {
  return `Basic ${Buffer.from(`${creds.login}:${creds.password}`).toString('base64')}`;
}

export function getCredentials(env: Record<string, string>): BusinessCredentials {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  if (!login || !password) {
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');
  }
  return { login, password };
}

// ── Cost tracking ─────────────────────────────────────────────

function logCost(operation: string, cost: number): void {
  const line = `${new Date().toISOString()} | business | ${operation} | $${cost.toFixed(4)}\n`;
  try {
    fs.mkdirSync(path.dirname(COST_LOG), { recursive: true });
    fs.appendFileSync(COST_LOG, line);
  } catch {
    // Non-fatal
  }
}

// ── API call helper ───────────────────────────────────────────

async function apiCall(
  endpoint: string,
  creds: BusinessCredentials,
  body?: any,
): Promise<any> {
  const url = `${DATAFORSEO_API}${endpoint}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: makeAuthHeader(creds),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`DataForSEO ${endpoint} HTTP ${resp.status}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

// ── Phone utilities ───────────────────────────────────────────

/** Extract US phone patterns from text */
export function extractPhoneFromText(text: string): string | null {
  if (!text) return null;
  // Match common US phone formats: (208) 555-1234, 208-555-1234, 2085551234, +1-208-555-1234
  const patterns = [
    /\+?1?[-.\s]?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/,
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) return match[0];
  }
  return null;
}

/** Normalize phone to digits only for comparison */
export function normalizePhone(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D/g, '');
  // Strip leading 1 (US country code) if 11 digits
  if (digits.length === 11 && digits.startsWith('1')) {
    return digits.slice(1);
  }
  return digits.length >= 10 ? digits : null;
}

// ── NAP comparison ────────────────────────────────────────────

/** Fuzzy name match — lowercased, stripped of punctuation */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

export function compareNAP(
  canonical: CanonicalNAP,
  found: { name: string | null; address: string | null; phone: string | null },
): { name: boolean | null; address: boolean | null; phone: boolean | null; consistent: boolean | null } {
  const nameMatch = canonical.name && found.name
    ? normalizeName(canonical.name) === normalizeName(found.name)
    : null;

  const phoneMatch = canonical.phone && found.phone
    ? normalizePhone(canonical.phone) === normalizePhone(found.phone)
    : null;

  // Address: check if found address contains key parts of canonical
  const addressMatch = canonical.address && found.address
    ? found.address.toLowerCase().includes(
        canonical.address.toLowerCase().split(',')[0].trim(),
      )
    : null;

  // Consistent = all non-null matches are true
  const checks = [nameMatch, phoneMatch, addressMatch].filter((c) => c !== null);
  const consistent = checks.length > 0 ? checks.every((c) => c === true) : null;

  return { name: nameMatch, address: addressMatch, phone: phoneMatch, consistent };
}

// ── GBP Lookup ────────────────────────────────────────────────

export async function fetchGBPListing(
  env: Record<string, string>,
  businessName: string,
  city: string,
  state: string,
): Promise<GBPResult> {
  const creds = getCredentials(env);
  const fullState = expandState(state);

  console.log(`  Fetching GBP listing for "${businessName}" in ${city}, ${fullState}...`);

  const payload = [
    {
      keyword: businessName,
      location_name: `${city},${fullState},United States`,
      language_code: 'en',
    },
  ];

  const data = await apiCall(
    '/business_data/google/my_business_info/live',
    creds,
    payload,
  );

  const task = data?.tasks?.[0];
  const cost = task?.cost ?? 0;
  logCost('my_business_info/live', cost);
  console.log(`  GBP lookup cost: $${cost.toFixed(4)}`);

  const items = task?.result?.[0]?.items ?? [];

  if (items.length === 0) {
    console.log('  No GBP listing found');
    return {
      listing_found: false,
      match_confidence: null,
      matched_name: null,
      category: null,
      additional_categories: [],
      rating: null,
      review_count: null,
      photo_count: null,
      is_claimed: null,
      website_url: null,
      work_hours: null,
      attributes: null,
      canonical_name: null,
      canonical_address: null,
      canonical_phone: null,
      cid: null,
      place_id: null,
      gbp_missing: true,
      raw_response: items.length > 0 ? items[0] : null,
    };
  }

  // Take the first (best match) result
  const item = items[0];

  // Determine match confidence based on name similarity
  const foundName = item.title || item.name || '';
  const normalizedSearch = normalizeName(businessName);
  const normalizedFound = normalizeName(foundName);
  let confidence = 'low';
  if (normalizedSearch === normalizedFound) {
    confidence = 'exact';
  } else if (normalizedFound.includes(normalizedSearch) || normalizedSearch.includes(normalizedFound)) {
    confidence = 'high';
  } else {
    // Check word overlap
    const searchWords = normalizedSearch.split(' ');
    const foundWords = normalizedFound.split(' ');
    const overlap = searchWords.filter((w) => foundWords.includes(w)).length;
    if (overlap >= Math.ceil(searchWords.length * 0.5)) {
      confidence = 'medium';
    }
  }

  // Extract address components
  const address = item.address || item.address_info?.address || null;
  const phone = item.phone || null;

  // DataForSEO returns rating as object {rating_type, value, votes_count} or number
  const ratingVal = typeof item.rating === 'object' && item.rating !== null
    ? item.rating.value ?? null
    : item.rating ?? null;
  const reviewCount = typeof item.rating === 'object' && item.rating !== null
    ? item.rating.votes_count ?? null
    : item.reviews_count ?? item.review_count ?? null;

  console.log(`  GBP found: "${foundName}" (confidence: ${confidence}, rating: ${ratingVal ?? 'N/A'}, reviews: ${reviewCount ?? 'N/A'})`);

  return {
    listing_found: true,
    match_confidence: confidence,
    matched_name: foundName,
    category: item.category || null,
    additional_categories: item.additional_categories ?? [],
    rating: ratingVal,
    review_count: reviewCount,
    photo_count: item.photos_count ?? item.photo_count ?? null,
    is_claimed: item.is_claimed ?? null,
    website_url: item.url ?? item.website ?? null,
    work_hours: item.work_hours ?? item.work_time ?? null,
    attributes: item.attributes ?? null,
    canonical_name: foundName || null,
    canonical_address: address,
    canonical_phone: phone,
    cid: item.cid ?? null,
    place_id: item.place_id ?? null,
    gbp_missing: false,
    raw_response: item,
  };
}

// ── SERP Citation Scan ────────────────────────────────────────

export async function searchDirectoryListing(
  env: Record<string, string>,
  businessName: string,
  cityState: string,
  directoryDomain: string,
): Promise<{ found: boolean; url: string | null; snippet: string | null }> {
  const creds = getCredentials(env);
  const keyword = `"${businessName}" "${cityState}" site:${directoryDomain}`;

  const payload = [
    {
      keyword,
      location_code: 2840, // US
      language_code: 'en',
      depth: 10,
    },
  ];

  const data = await apiCall(
    '/serp/google/organic/live/regular',
    creds,
    payload,
  );

  const task = data?.tasks?.[0];
  const cost = task?.cost ?? 0;
  logCost(`serp/organic (${directoryDomain})`, cost);

  const items = task?.result?.[0]?.items ?? [];
  const organic = items.filter((i: any) => i.type === 'organic');

  if (organic.length === 0) {
    return { found: false, url: null, snippet: null };
  }

  const top = organic[0];
  return {
    found: true,
    url: top.url ?? null,
    snippet: top.description ?? top.snippet ?? null,
  };
}

/**
 * Run citation scan across all SERP directories.
 * Returns one CitationResult per directory.
 */
export async function scanCitations(
  env: Record<string, string>,
  businessName: string,
  cityState: string,
  canonicalNAP: CanonicalNAP,
): Promise<CitationResult[]> {
  const results: CitationResult[] = [];

  for (const dir of CITATION_DIRECTORIES) {
    console.log(`  Scanning ${dir.name} (${dir.domain})...`);

    try {
      const serp = await searchDirectoryListing(env, businessName, cityState, dir.domain);

      let foundName: string | null = null;
      let foundPhone: string | null = null;
      let foundAddress: string | null = null;

      if (serp.found && serp.snippet) {
        // Extract NAP from SERP snippet
        foundPhone = extractPhoneFromText(serp.snippet);
        // Name is typically the page title / first line — use business name from snippet if present
        const snippetLower = serp.snippet.toLowerCase();
        if (snippetLower.includes(businessName.toLowerCase().split(' ')[0])) {
          foundName = businessName; // SERP mentions the business
        }
        // Address: look for city/state mention
        if (snippetLower.includes(cityState.toLowerCase().split(',')[0].trim().toLowerCase())) {
          foundAddress = serp.snippet.slice(0, 200); // best-effort from snippet
        }
      }

      const napCheck = serp.found
        ? compareNAP(canonicalNAP, { name: foundName, address: foundAddress, phone: foundPhone })
        : { name: null, address: null, phone: null, consistent: null };

      results.push({
        directory_name: dir.name,
        directory_domain: dir.domain,
        listing_found: serp.found,
        listing_url: serp.url,
        found_name: foundName,
        found_address: foundAddress,
        found_phone: foundPhone,
        nap_match_name: napCheck.name,
        nap_match_address: napCheck.address,
        nap_match_phone: napCheck.phone,
        nap_consistent: napCheck.consistent,
        data_source: 'serp',
        raw_snippet: serp.snippet,
      });

      console.log(`    ${dir.name}: ${serp.found ? 'FOUND' : 'not found'}${napCheck.consistent === true ? ' (NAP consistent)' : napCheck.consistent === false ? ' (NAP mismatch)' : ''}`);
    } catch (err: any) {
      console.error(`    ${dir.name}: ERROR — ${err.message}`);
      results.push({
        directory_name: dir.name,
        directory_domain: dir.domain,
        listing_found: false,
        listing_url: null,
        found_name: null,
        found_address: null,
        found_phone: null,
        nap_match_name: null,
        nap_match_address: null,
        nap_match_phone: null,
        nap_consistent: null,
        data_source: 'serp',
        raw_snippet: null,
      });
    }
  }

  return results;
}
