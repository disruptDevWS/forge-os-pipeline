# Lovable Session: Prospect Share Page

> **Prerequisite**: Forge OS pipeline changes must be complete and verified before this session begins. Specifically:
> - `share_token`, `share_token_created_at`, `brand_favicon_url`, `scout_markdown`, `scout_scope_json`, `prospect_narrative` columns exist on `prospects`
> - `scout-config` edge function deployed with `generate_share_token` and `get_share_report` actions
> - `get_share_report` confirmed accessible without auth (test with curl before starting)
> - A scouted prospect exists with data in the new columns (re-run Scout to populate)

---

## Pre-Implementation Checks

1. Read `src/types/database.ts` — verify `prospects` type has `share_token`, `share_token_created_at`, `brand_favicon_url` columns (add if missing)
2. Read `src/hooks/useProspects.ts` — understand existing hook structure before adding
3. Read `App.tsx` — confirm current route list and `ProtectedRoute` pattern
4. Read existing `/share/:token` route (`SharedAudit.tsx` or equivalent) — understand the anonymous route pattern already in use
5. Confirm `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` env vars are present (needed for unauthenticated edge function call)

---

## File Table

| File | Action | Purpose |
|------|--------|---------|
| `src/types/database.ts` | EDIT | Add share/brand columns to `prospects` Row/Insert/Update types |
| `src/hooks/useProspects.ts` | EDIT | Add `useGenerateShareToken()` hook |
| `src/pages/ScoutShareReport.tsx` | CREATE | Public share page — no auth required |
| `src/components/scout/ProspectShareHeader.tsx` | CREATE | Branded header for share page |
| `src/components/scout/NarrativeSection.tsx` | CREATE | Renders prospect-narrative.md as styled sections |
| `src/components/scout/ShareLinkButton.tsx` | CREATE | Copy-to-clipboard button for ScoutReport + ScoutDashboard |
| `App.tsx` | EDIT | Add `/share/scout/:token` route (no ProtectedRoute wrapper) |
| `src/pages/ScoutReport.tsx` | EDIT | Add ShareLinkButton to sidebar |
| `src/pages/ScoutDashboard.tsx` | EDIT | Add ShareLinkButton to row actions |

---

## 1. Type Updates (`src/types/database.ts`)

Add to `prospects.Row`:
```typescript
share_token: string | null;
share_token_created_at: string | null;
brand_favicon_url: string | null;
```

Add to `prospects.Update`:
```typescript
share_token?: string | null;
share_token_created_at?: string | null;
```

(`brand_favicon_url` is pipeline-written — dashboard never writes it.)

---

## 2. Hook: `useGenerateShareToken()`

Add to `src/hooks/useProspects.ts`:

```typescript
export function useGenerateShareToken() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (prospectId: string): Promise<{ token: string; share_url: string }> => {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke('scout-config', {
        body: { action: 'generate_share_token', prospect_id: prospectId },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw new Error(res.error.message);
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
    },
  });
}
```

---

## 3. `ShareLinkButton` Component

`src/components/scout/ShareLinkButton.tsx`

**Props**: `{ prospectId: string; existingToken: string | null }`

**Behavior**:
- If `existingToken` is not null: show "Copy Link" button. On click, copy `${window.location.origin}/share/scout/${existingToken}` to clipboard. Show checkmark for 2s.
- If `existingToken` is null: show "Generate Link" button. On click, call `useGenerateShareToken(prospectId)`, then copy the returned URL to clipboard.
- Loading state: spinner while mutation is in flight.
- Both states use the same button component — only label and icon change.

```tsx
// Compact, inline — fits in a table row action or sidebar card
<Button
  variant="outline"
  size="sm"
  onClick={handleShare}
  disabled={isPending}
>
  {isPending ? (
    <Loader2 className="h-4 w-4 animate-spin mr-1" />
  ) : copied ? (
    <Check className="h-4 w-4 mr-1 text-green-500" />
  ) : (
    <Share2 className="h-4 w-4 mr-1" />
  )}
  {copied ? 'Copied' : existingToken ? 'Copy Link' : 'Share'}
</Button>
```

---

## 4. Route Addition (`App.tsx`)

```tsx
// Add OUTSIDE the ProtectedRoute wrapper — no auth required
<Route path="/share/scout/:token" element={<ScoutShareReport />} />
```

Place it alongside the existing `/share/:token` anonymous route.

---

## 5. `ScoutShareReport` Page

`src/pages/ScoutShareReport.tsx`

This page has **no auth requirement**. It calls `get_share_report` directly using the anon key (no JWT).

### Data fetching

```typescript
const { token } = useParams<{ token: string }>();

const { data, isLoading, error } = useQuery({
  queryKey: ['scout-share', token],
  queryFn: async () => {
    // Unauthenticated call — use anon key, no Authorization header
    const res = await supabase.functions.invoke('scout-config', {
      body: { action: 'get_share_report', token },
      // No Authorization header — edge function bypasses auth for this action
    });
    if (res.error) throw new Error(res.error.message);
    return res.data as {
      prospect: {
        name: string;
        domain: string;
        geo_type: string;
        target_geos: any;
        scout_run_at: string;
        brand_favicon_url: string | null;
      };
      markdown: string;
      scope: any;
      narrative: string | null;
    };
  },
  enabled: !!token,
  retry: false, // 404 means invalid token — don't retry
});
```

### Page layout

**No app navigation** — this is a standalone public page, not wrapped in `<AppLayout>`. Think of it as a microsite.

```
┌─────────────────────────────────────────────────────┐
│  ProspectShareHeader                                 │
│  (prospect favicon + Forge Growth attribution)      │
├─────────────────────────────────────────────────────┤
│                                                      │
│  NarrativeSection                                    │
│  (prospect-narrative.md rendered as styled prose)   │
│                                                      │
├─────────────────────────────────────────────────────┤
│  [▼ See the data behind this analysis]  (accordion) │
├─────────────────────────────────────────────────────┤
│  Technical sections (collapsed by default):         │
│  - Canonical Topic Set (table)                      │
│  - Current Ranking Profile (table)                  │
│  - Gap Matrix (table)                               │
│  - LP Opportunity Summary (tables)                  │
│                                                      │
├─────────────────────────────────────────────────────┤
│  Footer CTA                                          │
│  "Want the full picture? → forgegrowth.ai"          │
└─────────────────────────────────────────────────────┘
```

**Important**: Section 7 (scope.json block) should NOT render in the share view — that's pipeline config, not prospect-facing. The narrative is the primary content. Technical sections are secondary and collapsed.

### Error states

```tsx
// 404 / invalid token
if (error) {
  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center max-w-md">
        <h1 className="text-xl font-semibold mb-2">Report not found</h1>
        <p className="text-muted-foreground">
          This link may have expired or is no longer valid.
        </p>
      </div>
    </div>
  );
}
```

---

## 6. `ProspectShareHeader` Component

`src/components/scout/ProspectShareHeader.tsx`

**Props**: `{ prospect: { name, domain, brand_favicon_url, scout_run_at } }`

Renders a header with the prospect's favicon and Forge Growth attribution:

```tsx
<header className="bg-white border-b border-t-4 border-t-[#e85d26] px-8 py-6">
  <div className="max-w-3xl mx-auto flex items-center justify-between">
    <div className="flex items-center gap-3">
      {prospect.brand_favicon_url && (
        <img
          src={prospect.brand_favicon_url}
          alt=""
          className="w-8 h-8 rounded"
          onError={(e) => { e.currentTarget.style.display = 'none'; }}
        />
      )}
      <div>
        <h1 className="text-lg font-semibold">{prospect.name}</h1>
        <p className="text-sm text-muted-foreground">{prospect.domain}</p>
      </div>
    </div>
    <div className="text-right text-sm text-muted-foreground">
      <p>Search Intelligence Report</p>
      <p>Prepared by <span className="font-medium text-foreground">Forge Growth</span></p>
    </div>
  </div>
</header>
```

The top border accent uses Forge orange (`#e85d26`) as a static brand color. The favicon comes from Google's favicon service (`https://www.google.com/s2/favicons?domain={domain}&sz=64`), populated by the pipeline at Scout completion.

---

## 7. `NarrativeSection` Component

`src/components/scout/NarrativeSection.tsx`

**Props**: `{ narrative: string }`

The `narrative` field is the raw markdown content of `prospect-narrative.md`. It has three sections:
- "Where You're Winning"
- "Where Demand Is Escaping You"
- "What a Full Analysis Would Reveal"

Render with `react-markdown` using the same `markdownComponents` already used in `ScoutReport.tsx`. Style for a comfortable reading width (max-w-2xl, generous line-height) — this is prose meant for a business owner, not a data table.

```tsx
<div className="max-w-2xl mx-auto px-8 py-10">
  <ReactMarkdown components={markdownComponents}>
    {narrative}
  </ReactMarkdown>
</div>
```

If `narrative` is null (older scouts before the narrative feature): render a fallback message: "Detailed analysis available upon request." — don't crash.

---

## 8. Technical Sections (Collapsed Accordion)

The technical sections come from `markdown` — the full scout report rendered via `react-markdown`. Wrap in a `<details>`/`<summary>` or a Shadcn `Collapsible` component.

Strip the scope.json block (Section 7 in the markdown) before rendering — it's pipeline config. Simple approach: split on `## 7.` and discard that section and everything after it until the next top-level heading (or end of document).

```typescript
function stripPipelineSection(markdown: string): string {
  // Remove Section 7 (scope.json) — pipeline config, not prospect-facing
  return markdown.replace(/## 7\.[\s\S]*?(?=## \d+\.|$)/g, '').trim();
}
```

---

## 9. ScoutDashboard + ScoutReport Integration

### ScoutDashboard.tsx

In the actions column, add `ShareLinkButton` after the "View Report" button:

```tsx
<ShareLinkButton
  prospectId={prospect.id}
  existingToken={prospect.share_token}
/>
```

Only show when `prospect.status === 'scouted' || prospect.status === 'converted'`.

### ScoutReport.tsx

In the right sidebar, below the Prospect Info Card, add a "Share Report" card:

```tsx
<Card>
  <CardHeader className="pb-2">
    <CardTitle className="text-sm font-medium">Share Report</CardTitle>
  </CardHeader>
  <CardContent>
    <p className="text-xs text-muted-foreground mb-3">
      Send a direct link to this prospect. No login required.
    </p>
    <ShareLinkButton
      prospectId={prospect.id}
      existingToken={prospect.share_token ?? null}
    />
    {prospect.share_token && (
      <p className="text-xs text-muted-foreground mt-2">
        Link active · {prospect.share_token_created_at
          ? new Date(prospect.share_token_created_at).toLocaleDateString()
          : ''}
      </p>
    )}
  </CardContent>
</Card>
```

---

## Edge Function Reference

Both actions use the `scout-config` edge function (`supabase/functions/scout-config/index.ts`).

### `generate_share_token` (authenticated — super_admin required)

**Request**:
```json
{ "action": "generate_share_token", "prospect_id": "<uuid>" }
```

**Response** (200):
```json
{
  "token": "<uuid>",
  "share_url": "https://app.forgegrowth.ai/share/scout/<uuid>",
  "domain": "example.com",
  "name": "Example Business"
}
```

### `get_share_report` (public — no auth required)

**Request**:
```json
{ "action": "get_share_report", "token": "<uuid>" }
```

**Response** (200):
```json
{
  "prospect": {
    "name": "Example Business",
    "domain": "example.com",
    "geo_type": "local",
    "target_geos": [...],
    "scout_run_at": "2026-03-19T...",
    "brand_favicon_url": "https://www.google.com/s2/favicons?domain=example.com&sz=64"
  },
  "markdown": "# Scout Report\n...",
  "scope": { ... },
  "narrative": "# Where Example Business Stands Online\n..."
}
```

**Error** (404): `{ "error": "Report not found" }` or `{ "error": "Scout report not yet available" }`

---

## Definition of Done

### Types + Hooks
- [ ] `prospects.Row` type includes `share_token`, `share_token_created_at`, `brand_favicon_url`
- [ ] `useGenerateShareToken()` mutation in `useProspects.ts`

### Share Page
- [ ] `/share/scout/:token` route exists in `App.tsx` outside `ProtectedRoute`
- [ ] `ScoutShareReport.tsx` renders without auth — verify in incognito browser tab
- [ ] Invalid token shows error state (not a crash)
- [ ] Narrative section renders if `narrative` is non-null
- [ ] Narrative section shows fallback if `narrative` is null
- [ ] Section 7 (scope.json block) does NOT appear in the share view
- [ ] Technical sections are collapsed by default
- [ ] Page renders without `<AppLayout>` / no app nav visible

### Header + Branding
- [ ] `ProspectShareHeader` uses Forge orange (`#e85d26`) top border accent
- [ ] Favicon renders if `brand_favicon_url` is non-null; hidden gracefully if broken
- [ ] "Prepared by Forge Growth" attribution visible

### Dashboard Integration
- [ ] `ShareLinkButton` appears in ScoutDashboard row actions for scouted/converted prospects
- [ ] `ShareLinkButton` appears in ScoutReport sidebar
- [ ] "Generate Link" → generates token → copies URL to clipboard
- [ ] "Copy Link" → copies existing token URL to clipboard
- [ ] Copied state shows checkmark for 2s then resets

### End-to-End Test
- [ ] Open ScoutReport for a scouted prospect in the app
- [ ] Click "Generate Link" — token appears, URL copied
- [ ] Open the URL in an incognito tab — report loads without login
- [ ] Narrative section visible and readable
- [ ] Technical accordion expands and shows tables
- [ ] Scope.json block absent from the page
