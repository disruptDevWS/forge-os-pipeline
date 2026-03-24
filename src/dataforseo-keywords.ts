/**
 * dataforseo-keywords.ts — Standalone DataForSEO volume lookup utility.
 *
 * Used by the /lookup-keywords endpoint for ad-hoc keyword research.
 * Unlike pipeline-generate's bulkKeywordVolume, this returns ALL keywords
 * including zero-volume ones (the pipeline filters those for revenue modeling).
 */

export interface BulkVolumeResult {
  keyword: string;
  volume: number;
  cpc: number;
  competition: number | null;
  competition_level: string | null;
}

/** Strip characters DataForSEO rejects: parentheses, brackets, special symbols */
export function sanitizeKeyword(kw: string): string {
  return kw
    .replace(/\([^)]*\)/g, '') // strip parenthesized content e.g. "(ACLS)"
    .replace(/[[\]{}()]/g, '') // any remaining brackets/parens
    .replace(/\s{2,}/g, ' ') // collapse double spaces
    .trim();
}

const CHUNK_SIZE = 1000;

async function fetchVolumeForLocation(
  authString: string,
  keywords: string[],
  locationCode: number,
): Promise<Map<string, BulkVolumeResult>> {
  const results = new Map<string, BulkVolumeResult>();

  for (let i = 0; i < keywords.length; i += CHUNK_SIZE) {
    const chunk = keywords.slice(i, i + CHUNK_SIZE);
    console.log(
      `  Fetching volume for ${chunk.length} keywords (batch ${Math.floor(i / CHUNK_SIZE) + 1}, location ${locationCode})...`,
    );

    const resp = await fetch(
      'https://api.dataforseo.com/v3/keywords_data/google_ads/search_volume/live',
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${authString}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify([
          { keywords: chunk, location_code: locationCode, language_code: 'en' },
        ]),
      },
    );
    if (!resp.ok)
      throw new Error(
        `DataForSEO search_volume HTTP ${resp.status} (location ${locationCode})`,
      );
    const data: any = await resp.json();

    for (const task of data?.tasks ?? []) {
      if (task.status_code !== 20000) {
        console.warn(
          `  DataForSEO task error: ${task.status_code} — ${task.status_message}`,
        );
        continue;
      }
      for (const item of task?.result ?? []) {
        results.set(item.keyword, {
          keyword: item.keyword,
          volume: item.search_volume ?? 0,
          cpc: item.cpc ?? 0,
          competition: item.competition ?? null,
          competition_level: item.competition_level ?? null,
        });
      }
    }
  }

  return results;
}

/**
 * Look up keyword volumes via DataForSEO. Returns results for ALL input
 * keywords — zero-volume keywords are synthesized with volume=0, cpc=0.
 */
export async function lookupKeywordVolumes(
  env: Record<string, string | undefined>,
  keywords: string[],
  locationCodes?: number[],
): Promise<BulkVolumeResult[]> {
  const login = env.DATAFORSEO_LOGIN;
  const password = env.DATAFORSEO_PASSWORD;
  if (!login || !password)
    throw new Error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD not set');

  const authString = Buffer.from(`${login}:${password}`).toString('base64');
  const codes = locationCodes ?? [2840]; // Default: US

  // Sanitize and deduplicate, maintaining mapping back to originals
  const originalByClean = new Map<string, string[]>();
  for (const kw of keywords) {
    const clean = sanitizeKeyword(kw);
    if (!clean) continue;
    const existing = originalByClean.get(clean);
    if (existing) {
      existing.push(kw);
    } else {
      originalByClean.set(clean, [kw]);
    }
  }
  const cleanKeywords = [...originalByClean.keys()];

  if (cleanKeywords.length === 0) return [];

  // Aggregate across locations: sum volume, max CPC, max competition
  const aggregated = new Map<string, BulkVolumeResult>();

  for (let li = 0; li < codes.length; li++) {
    if (li > 0) await new Promise((r) => setTimeout(r, 1000));
    const locationResults = await fetchVolumeForLocation(
      authString,
      cleanKeywords,
      codes[li],
    );
    for (const [cleanKw, result] of locationResults) {
      const existing = aggregated.get(cleanKw);
      if (existing) {
        existing.volume += result.volume;
        existing.cpc = Math.max(existing.cpc, result.cpc);
        existing.competition = Math.max(
          existing.competition ?? 0,
          result.competition ?? 0,
        );
        if (
          result.competition_level &&
          (!existing.competition_level ||
            result.competition_level > existing.competition_level)
        ) {
          existing.competition_level = result.competition_level;
        }
      } else {
        aggregated.set(cleanKw, { ...result });
      }
    }
  }

  // Build final results — include ALL original keywords, even zero-volume
  const results: BulkVolumeResult[] = [];
  const seen = new Set<string>();

  for (const [cleanKw, originals] of originalByClean) {
    const apiResult = aggregated.get(cleanKw);
    for (const orig of originals) {
      const lower = orig.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);

      if (apiResult) {
        results.push({ ...apiResult, keyword: orig });
      } else {
        results.push({
          keyword: orig,
          volume: 0,
          cpc: 0,
          competition: null,
          competition_level: null,
        });
      }
    }
  }

  const tasks = codes.length * Math.ceil(cleanKeywords.length / CHUNK_SIZE);
  const estimatedCost = 0.075 * tasks;
  console.log(
    `  Lookup complete: ${results.length} keywords, ${results.filter((r) => r.volume > 0).length} with volume, ${tasks} API tasks (~$${estimatedCost.toFixed(3)})`,
  );

  return results;
}
