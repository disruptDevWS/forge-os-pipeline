/**
 * fetch-ga4-data.ts — Google Analytics 4 Data API fetcher.
 *
 * Library module only (no CLI entry point).
 * Called from track-rankings.ts step 9 for published page behavioral data,
 * and step 9b for event-level conversion data.
 *
 * Exports:
 *   runGa4Fetch(auditId, publishedSlugs, sb) → Ga4PageData[]
 *   runGa4EventFetch(auditId, sb) → Ga4EventData[]
 */

import { SupabaseClient } from '@supabase/supabase-js';
import { getServiceAccountAccessToken, getAnalyticsConnection } from './google-auth.js';

// ============================================================
// Types
// ============================================================

export interface Ga4PageData {
  page_url: string;
  total_sessions: number;
  total_conversions: number;
  total_revenue: number;
  organic_sessions: number;
  organic_engaged_sessions: number;
  organic_engagement_rate: number;
  organic_conversions: number;
  organic_avg_session_dur: number;
  organic_cr: number;
}

interface Ga4Row {
  dimensionValues: Array<{ value: string }>;
  metricValues: Array<{ value: string }>;
}

// ============================================================
// GA4 API
// ============================================================

const GA4_SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

async function fetchGa4Report(
  propertyId: string,
  slugs: string[],
  token: string,
  useKeyEvents: boolean,
): Promise<{ rows: Ga4Row[]; metricName: string }> {
  const apiUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  // Build slug filter values (GA4 landingPage dimension includes leading /)
  const filterValues = slugs.map((s) => `/${s.replace(/^\/+/, '')}`);

  const conversionMetric = useKeyEvents ? 'keyEvents' : 'conversions';
  const metricLabel = useKeyEvents ? 'keyEvents' : 'conversions';

  // 28-day lookback
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  const body = {
    dateRanges: [{
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    }],
    dimensions: [
      { name: 'landingPage' },
      { name: 'sessionDefaultChannelGroup' },
    ],
    metrics: [
      { name: 'sessions' },
      { name: 'engagedSessions' },
      { name: conversionMetric },
      { name: 'totalRevenue' },
      { name: 'averageSessionDuration' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'landingPage',
        inListFilter: {
          values: filterValues,
        },
      },
    },
    limit: 10000,
  };

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    // Check if keyEvents was rejected — fall back to conversions
    if (useKeyEvents && errText.includes('keyEvents')) {
      return { rows: [], metricName: 'keyEvents_rejected' };
    }
    throw new Error(`GA4 runReport failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  return { rows: data.rows ?? [], metricName: metricLabel };
}

// ============================================================
// Data aggregation
// ============================================================

function aggregateGa4Data(rows: Ga4Row[]): Ga4PageData[] {
  // Group by landing page, separate organic vs all channels
  const pageMap = new Map<string, {
    totalSessions: number;
    totalConversions: number;
    totalRevenue: number;
    organicSessions: number;
    organicEngagedSessions: number;
    organicConversions: number;
    organicRevenue: number;
    organicSessionDurSum: number;
  }>();

  for (const row of rows) {
    const landingPage = row.dimensionValues[0].value;
    const channel = row.dimensionValues[1].value;
    const sessions = parseInt(row.metricValues[0].value) || 0;
    const engagedSessions = parseInt(row.metricValues[1].value) || 0;
    const conversions = parseInt(row.metricValues[2].value) || 0;
    const revenue = parseFloat(row.metricValues[3].value) || 0;
    const avgDuration = parseFloat(row.metricValues[4].value) || 0;

    // Normalize path
    const pagePath = landingPage.replace(/\/+$/, '') || '/';

    if (!pageMap.has(pagePath)) {
      pageMap.set(pagePath, {
        totalSessions: 0,
        totalConversions: 0,
        totalRevenue: 0,
        organicSessions: 0,
        organicEngagedSessions: 0,
        organicConversions: 0,
        organicRevenue: 0,
        organicSessionDurSum: 0,
      });
    }

    const agg = pageMap.get(pagePath)!;
    agg.totalSessions += sessions;
    agg.totalConversions += conversions;
    agg.totalRevenue += revenue;

    if (channel === 'Organic Search') {
      agg.organicSessions += sessions;
      agg.organicEngagedSessions += engagedSessions;
      agg.organicConversions += conversions;
      agg.organicRevenue += revenue;
      agg.organicSessionDurSum += avgDuration * sessions; // weighted
    }
  }

  const results: Ga4PageData[] = [];
  for (const [pagePath, agg] of pageMap) {
    const organicEngagementRate = agg.organicSessions > 0
      ? agg.organicEngagedSessions / agg.organicSessions
      : 0;
    const organicCr = agg.organicSessions > 0
      ? agg.organicConversions / agg.organicSessions
      : 0;
    const organicAvgDur = agg.organicSessions > 0
      ? agg.organicSessionDurSum / agg.organicSessions
      : 0;

    results.push({
      page_url: pagePath,
      total_sessions: agg.totalSessions,
      total_conversions: agg.totalConversions,
      total_revenue: Number(agg.totalRevenue.toFixed(2)),
      organic_sessions: agg.organicSessions,
      organic_engaged_sessions: agg.organicEngagedSessions,
      organic_engagement_rate: Number(organicEngagementRate.toFixed(4)),
      organic_conversions: agg.organicConversions,
      organic_avg_session_dur: Number(organicAvgDur.toFixed(2)),
      organic_cr: Number(organicCr.toFixed(6)),
    });
  }

  return results;
}

// ============================================================
// Exported runner
// ============================================================

/**
 * Fetch GA4 behavioral data for published pages.
 * Returns empty array if no GA4 connection exists.
 */
export async function runGa4Fetch(
  auditId: string,
  publishedSlugs: string[],
  sb: SupabaseClient,
): Promise<Ga4PageData[]> {
  if (publishedSlugs.length === 0) {
    console.log('  [ga4] No published slugs to fetch');
    return [];
  }

  // Get analytics connection
  const connection = await getAnalyticsConnection(sb, auditId);
  if (!connection || !connection.ga4_property_id) {
    console.log('  [ga4] No active GA4 connection found — skipping');
    return [];
  }

  const propertyId = connection.ga4_property_id;
  console.log(`  [ga4] GA4 property: ${propertyId} (${publishedSlugs.length} slugs)`);

  // Get access token
  const token = await getServiceAccountAccessToken([GA4_SCOPE]);

  // Try keyEvents first, fall back to conversions
  let result = await fetchGa4Report(propertyId, publishedSlugs, token, true);

  if (result.metricName === 'keyEvents_rejected') {
    console.log('  [ga4] Fallback: using deprecated "conversions" metric (keyEvents rejected)');
    result = await fetchGa4Report(propertyId, publishedSlugs, token, false);
    console.log(`  [ga4] Using metric: conversions`);
  } else {
    console.log(`  [ga4] Using metric: keyEvents`);
  }

  console.log(`  [ga4] Received ${result.rows.length} rows from GA4`);

  if (result.rows.length === 0) {
    return [];
  }

  // Aggregate
  const pages = aggregateGa4Data(result.rows);
  console.log(`  [ga4] Aggregated ${pages.length} page records`);

  // Update last_ga4_sync_at
  await (sb as any)
    .from('analytics_connections')
    .update({ last_ga4_sync_at: new Date().toISOString() })
    .eq('audit_id', auditId);

  return pages;
}

// ============================================================
// Event-level conversion data (site-wide)
// ============================================================

export interface Ga4EventData {
  event_name: string;
  channel_group: string;
  event_count: number;
  event_revenue: number;
}

const CONVERSION_EVENT_NAMES = [
  'registration_complete',
  'contact_form_submit',
  'click_phone',
  'purchase',
];

async function fetchGa4EventReport(
  propertyId: string,
  token: string,
): Promise<Ga4Row[]> {
  const apiUrl = `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`;

  // 28-day lookback (same window as page-level fetch)
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 28);

  const body = {
    dateRanges: [{
      startDate: startDate.toISOString().slice(0, 10),
      endDate: endDate.toISOString().slice(0, 10),
    }],
    dimensions: [
      { name: 'eventName' },
      { name: 'sessionDefaultChannelGroup' },
    ],
    metrics: [
      { name: 'eventCount' },
      { name: 'totalRevenue' },
    ],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: {
          values: CONVERSION_EVENT_NAMES,
        },
      },
    },
    limit: 10000,
  };

  const resp = await fetch(apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`GA4 event runReport failed (${resp.status}): ${errText}`);
  }

  const data = await resp.json();
  return data.rows ?? [];
}

/**
 * Fetch GA4 event-level conversion data (site-wide, not per-page).
 * Returns empty array if no GA4 connection exists.
 */
export async function runGa4EventFetch(
  auditId: string,
  sb: SupabaseClient,
): Promise<Ga4EventData[]> {
  const connection = await getAnalyticsConnection(sb, auditId);
  if (!connection || !connection.ga4_property_id) {
    console.log('  [ga4-events] No active GA4 connection — skipping event fetch');
    return [];
  }

  const propertyId = connection.ga4_property_id;
  console.log(`  [ga4-events] Fetching conversion events for property ${propertyId}`);

  const token = await getServiceAccountAccessToken([GA4_SCOPE]);
  const rows = await fetchGa4EventReport(propertyId, token);

  console.log(`  [ga4-events] Received ${rows.length} event rows`);

  if (rows.length === 0) return [];

  const results: Ga4EventData[] = rows.map((row) => ({
    event_name: row.dimensionValues[0].value,
    channel_group: row.dimensionValues[1].value,
    event_count: parseInt(row.metricValues[0].value) || 0,
    event_revenue: parseFloat(row.metricValues[1].value) || 0,
  }));

  return results;
}
