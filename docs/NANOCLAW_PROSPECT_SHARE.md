\## Feature: Prospect Share Functionality

\## Execution Rules:

1\. First, read the tentative plan under #Pipeline Session: Prospect Share Token, current schema, types, and DECISIONS.md in both repos to understand the current state. You will create a revised plan as needed, and implement once approved.

2\. Create a dependency graph of all changes needed (migration → types → edge functions → sync bridge → UI components → docs).

3\. For each independent track, spawn a sub-agent. Each agent must:

&#x20;  - Make changes

&#x20;  - Run `npx tsc --noEmit` and fix any errors before reporting back

&#x20;  - Never use enum types or columns that don't already exist without explicitly creating them first

4\. After all tracks complete, run the full build in both repos.

5\. Update DECISIONS.md and MEMORY.md with what changed and why.

6\. Commit each repo separately with descriptive messages.

7\. Report: what was done, what was tested, what needs manual verification in production.





# Pipeline Session: Prospect Share Token

> **Scope**: Add `share_token` to `prospects` table + pipeline server endpoint to generate/retrieve it. No new edge function — the existing `scout-config` edge function gets a new action.
>
> **Sequence**: This session first. Lovable session depends on the token column and the new edge function action existing before wiring the UI.

---

## Pre-Implementation Checks

Before writing any code:

1. Confirm `prospects` table schema — verify current columns match DATA_CONTRACT.md
2. Confirm `pipeline-server-standalone.ts` current endpoint list matches PIPELINE.md
3. Confirm `scout-config` edge function file location and current action switch
4. Run `npx tsc --noEmit` — zero errors before starting

---

## File Table

| File | Action | Purpose |
|------|--------|---------|
| `supabase/migrations/YYYYMMDD_prospect_share_token.sql` | CREATE | Add `share_token` + `brand_color` columns to `prospects` |
| `supabase/functions/scout-config/index.ts` | EDIT | Add `generate_share_token` and `get_share_report` actions |
| `src/pipeline-server-standalone.ts` | EDIT | Add `POST /prospect-brand` endpoint for brand color extraction at scout time |
| `scripts/pipeline-generate.ts` | EDIT | Call brand color extraction after Scout completes (non-fatal) |

---

## 1. Migration

```sql
-- supabase/migrations/YYYYMMDD_prospect_share_token.sql

ALTER TABLE public.prospects
  ADD COLUMN IF NOT EXISTS share_token UUID DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS share_token_created_at TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS brand_color TEXT DEFAULT NULL,        -- hex, e.g. '#1a3c5e'
  ADD COLUMN IF NOT EXISTS brand_favicon_url TEXT DEFAULT NULL; -- absolute URL

CREATE UNIQUE INDEX IF NOT EXISTS prospects_share_token_idx
  ON public.prospects (share_token)
  WHERE share_token IS NOT NULL;

-- RLS: share token lookup is public (no auth required)
-- Existing super_admin policy already covers INSERT/UPDATE by authenticated users.
-- Add a separate SELECT policy for token-based anonymous access:

CREATE POLICY "public_share_token_read" ON public.prospects
  FOR SELECT
  USING (share_token IS NOT NULL);
```

**Important**: The existing `super_admin_full_access` policy uses `FOR ALL` — the new policy is additive. Anonymous token-based reads will match `public_share_token_read`. The RLS stack allows either path.

---

## 2. scout-config Edge Function — New Actions

Add two actions to the existing `switch(action)` block in `supabase/functions/scout-config/index.ts`.

### Action: `generate_share_token`

**Auth**: `validateSuperAdmin` (same as all other scout-config actions)

**Request body**: `{ action: 'generate_share_token', prospect_id: string }`

**Logic**:
```typescript
case 'generate_share_token': {
  const { prospect_id } = body;

  // Generate a new UUID token
  const token = crypto.randomUUID();

  const { data, error } = await supabaseClient
    .from('prospects')
    .update({
      share_token: token,
      share_token_created_at: new Date().toISOString(),
    })
    .eq('id', prospect_id)
    .select('share_token, domain, name')
    .single();

  if (error) throw error;

  return new Response(JSON.stringify({
    token: data.share_token,
    share_url: `${Deno.env.get('DASHBOARD_URL')}/share/scout/${data.share_token}`,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

Add `DASHBOARD_URL` to Supabase secrets: `supabase secrets set DASHBOARD_URL=https://app.forgegrowth.ai --project-ref hohuimkcpihdufunrzvg`

---

### Action: `get_share_report`

**Auth**: **None** — this action is publicly accessible via share token. Skip `validateSuperAdmin` for this action only.

**Request body**: `{ action: 'get_share_report', token: string }`

**Logic**:
```typescript
case 'get_share_report': {
  // NOTE: No super_admin check — public action
  const { token } = body;

  if (!token) {
    return new Response(JSON.stringify({ error: 'Token required' }), { status: 400 });
  }

  // Look up prospect by token
  // Use service role client here (not user-scoped) since this is unauthenticated
  const supabaseAdmin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: prospect, error } = await supabaseAdmin
    .from('prospects')
    .select('id, name, domain, geo_type, target_geos, status, scout_run_at, brand_color, brand_favicon_url, share_token')
    .eq('share_token', token)
    .single();

  if (error || !prospect) {
    return new Response(JSON.stringify({ error: 'Report not found' }), { status: 404 });
  }

  // Fetch the scout report from pipeline server (reuse existing read_report logic)
  const pipelineBase = Deno.env.get('PIPELINE_BASE_URL') ?? Deno.env.get('PIPELINE_TRIGGER_URL');
  const res = await fetch(`${pipelineBase}/scout-report`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${Deno.env.get('PIPELINE_TRIGGER_SECRET')}`,
    },
    body: JSON.stringify({ domain: prospect.domain }),
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: 'Scout report unavailable' }), { status: 502 });
  }

  const reportData = await res.json();

  return new Response(JSON.stringify({
    prospect: {
      name: prospect.name,
      domain: prospect.domain,
      geo_type: prospect.geo_type,
      target_geos: prospect.target_geos,
      scout_run_at: prospect.scout_run_at,
      brand_color: prospect.brand_color,
      brand_favicon_url: prospect.brand_favicon_url,
    },
    markdown: reportData.markdown,
    scope: reportData.scope,
    narrative: reportData.narrative,   // prospect-narrative.md content
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
```

**Auth guard placement**: The action switch must check for `get_share_report` BEFORE the `validateSuperAdmin` call. Structure:

```typescript
// At the top of the handler, before validateSuperAdmin:
if (action === 'get_share_report') {
  // handle and return — skip auth check
}

// validateSuperAdmin for all other actions
await validateSuperAdmin(req, supabaseClient);

switch(action) {
  case 'write_config': ...
  case 'trigger_scout': ...
  case 'read_report': ...
  case 'generate_share_token': ...
}
```

---

## 3. Brand Color Extraction (Non-Fatal, Scout Time)

### Pipeline Server Endpoint: `POST /prospect-brand`

Add to `src/pipeline-server-standalone.ts`:

```typescript
app.post('/prospect-brand', authenticate, async (req, res) => {
  const { domain, prospect_id } = req.body;

  if (!domain || !prospect_id) {
    return res.status(400).json({ error: 'domain and prospect_id required' });
  }

  try {
    // Fetch favicon URL candidates
    const faviconUrl = await extractFaviconUrl(domain);

    // Extract dominant color from favicon
    const brandColor = faviconUrl ? await extractDominantColor(faviconUrl) : null;

    // Update prospects row
    const { error } = await supabase
      .from('prospects')
      .update({
        brand_color: brandColor,
        brand_favicon_url: faviconUrl,
      })
      .eq('id', prospect_id);

    if (error) throw error;

    return res.json({ ok: true, brand_color: brandColor, favicon_url: faviconUrl });
  } catch (err) {
    // Non-fatal — log and return gracefully
    console.warn(`[prospect-brand] Failed for ${domain}:`, err);
    return res.json({ ok: false, error: String(err) });
  }
});
```

### Helper functions (add to pipeline server or a `scripts/brand-extractor.ts` utility):

```typescript
async function extractFaviconUrl(domain: string): Promise<string | null> {
  // Try standard locations in order
  const candidates = [
    `https://${domain}/favicon.ico`,
    `https://${domain}/apple-touch-icon.png`,
    `https://${domain}/favicon.png`,
  ];

  // Also try fetching the homepage and parsing <link rel="icon">
  try {
    const homeRes = await fetch(`https://${domain}`, {
      signal: AbortSignal.timeout(5000),
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ForgeOS/1.0)' },
    });
    const html = await homeRes.text();
    const match = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']+)["']/i)
                ?? html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
    if (match) {
      const href = match[1];
      candidates.unshift(href.startsWith('http') ? href : `https://${domain}${href}`);
    }
  } catch { /* ignore */ }

  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (res.ok) return url;
    } catch { /* continue */ }
  }
  return null;
}

async function extractDominantColor(imageUrl: string): Promise<string | null> {
  // Use the `sharp` npm package if available, or a simple pixel-sampling approach.
  // Pipeline server already has Node.js — add sharp if not present: npm install sharp
  try {
    const { default: sharp } = await import('sharp');
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(5000) });
    const buffer = Buffer.from(await res.arrayBuffer());

    // Resize to 1x1 — gives average color
    const { data } = await sharp(buffer)
      .resize(1, 1)
      .raw()
      .toBuffer({ resolveWithObject: true });

    const r = data[0], g = data[1], b = data[2];

    // If too dark or too light, fall back to null (let the UI use defaults)
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;
    if (brightness < 20 || brightness > 235) return null;

    return `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
  } catch {
    return null;
  }
}
```

### Call from Scout (non-fatal):

In `scripts/pipeline-generate.ts`, after `runScout()` completes successfully:

```typescript
// After runScout() completes — non-fatal brand extraction
if (prospectId) {
  try {
    const brandRes = await fetch(`${PIPELINE_BASE_URL}/prospect-brand`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${PIPELINE_TRIGGER_SECRET}`,
      },
      body: JSON.stringify({ domain, prospect_id: prospectId }),
    });
    const brandData = await brandRes.json();
    if (brandData.brand_color) {
      console.log(`[Scout] Brand color extracted: ${brandData.brand_color}`);
    }
  } catch (err) {
    console.warn('[Scout] Brand color extraction failed (non-fatal):', err);
  }
}
```

`prospectId` is already resolved in the Scout flow from the `prospects` table upsert — pass it through.

---

## DATA_CONTRACT.md Updates

Add to the `prospects` table section:

```
| `share_token` | Dashboard (edge fn) | Dashboard (public route) | UUID, nullable, unique |
| `share_token_created_at` | Dashboard (edge fn) | Dashboard | |
| `brand_color` | Pipeline (Scout) | Dashboard (share route) | Hex string or null |
| `brand_favicon_url` | Pipeline (Scout) | Dashboard (share route) | Absolute URL or null |
```

Add to Edge Functions table:

```
| `scout-config` | `generate_share_token` | (Supabase-only) | `{prospect_id}` | `{token, share_url}` |
| `scout-config` | `get_share_report` | `/scout-report` (proxied) | `{token}` | `{prospect, markdown, scope, narrative}` |
```

---

## DECISIONS.md Entry

```
**2026-03-19: Prospect share via token on prospects table, not audit_shares**

Scout reports are shared with cold prospects who have no app account. The existing
`audit_shares` table and `share-audit` edge function are designed for audit-level sharing
with token+password — appropriate for paying clients reviewing their full audit, not for
frictionless cold outreach. Added `share_token` directly to the `prospects` table (UUID,
unique, nullable) generated on demand via a new `generate_share_token` action in the
`scout-config` edge function. A separate `get_share_report` action bypasses super_admin
auth (token IS the credential) and proxies to the existing `/scout-report` pipeline
endpoint. No password required — the UUID token is sufficient entropy for a time-insensitive
sales artifact. Brand color + favicon extracted at scout completion via `/prospect-brand`
pipeline endpoint using `sharp` for pixel sampling; stored on the prospect row for use by
the share page renderer. Non-fatal if extraction fails.
```

---

## Definition of Done

- [ ] Migration applied — `share_token`, `share_token_created_at`, `brand_color`, `brand_favicon_url` columns exist on `prospects`
- [ ] Unique index on `share_token` confirmed in Supabase
- [ ] RLS policy `public_share_token_read` active — verify with anon key SELECT by token
- [ ] `scout-config` edge function deployed with `generate_share_token` action
- [ ] `scout-config` edge function deployed with `get_share_report` action — **no auth required**
- [ ] `get_share_report` bypasses `validateSuperAdmin` — verify with curl using no JWT
- [ ] `DASHBOARD_URL` secret set in Supabase
- [ ] `/prospect-brand` endpoint live on pipeline server
- [ ] `sharp` added to pipeline server dependencies
- [ ] Brand extraction called after Scout completes, logged, non-fatal
- [ ] Existing Scout run for `summitmedicalacademy.com` — manually backfill share token via `generate_share_token` action to test end-to-end before Lovable session
- [ ] `npx tsc --noEmit` passes after all changes
