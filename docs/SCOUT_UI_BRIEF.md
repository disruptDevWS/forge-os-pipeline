# Scout UI — Implementation Brief for Lovable

> **Target**: Forge OS Dashboard (`market-position-audit-lovable/`)
> **Access**: SuperAdmin only (`super_admin` role from `user_roles` table)
> **Dependencies**: `prospects` table + `pipeline-server.ts` (both already deployed)

---

## 1. Component Tree

All new files live in the existing frontend at `market-position-audit-lovable/src/`.

```
src/
├── pages/
│   ├── ScoutDashboard.tsx              ← Prospect list + status table (default export)
│   ├── ScoutNewProspect.tsx            ← Create prospect form (default export)
│   └── ScoutReport.tsx                 ← View scout output for a prospect (default export)
├── hooks/
│   └── useProspects.ts                 ← All prospect data hooks (named exports)
├── components/
│   └── scout/
│       ├── ProspectStatusBadge.tsx      ← Status badge helper (named export)
│       ├── GeoModeSelector.tsx          ← geo_mode radio + conditional inputs (named export)
│       ├── GapSummaryCard.tsx           ← LP opportunity summary card (named export)
│       └── ScoutMarkdownViewer.tsx      ← Renders scout report markdown (named export)
```

**No new directories beyond `components/scout/`.** Follows the existing `components/audit/` pattern.

---

## 2. Routing

Add to `App.tsx` inside the existing `<Routes>` block, after the audit routes:

```tsx
<Route path="/scout" element={<ProtectedRoute><ScoutDashboard /></ProtectedRoute>} />
<Route path="/scout/new" element={<ProtectedRoute><ScoutNewProspect /></ProtectedRoute>} />
<Route path="/scout/:id" element={<ProtectedRoute><ScoutReport /></ProtectedRoute>} />
```

All three pages self-check `super_admin` role and redirect non-admins (same pattern specified for `AdminUsers` in RBAC_SPEC.md — component-level redirect, not route-level).

**Navigation**: Add "Scout" link to `Header.tsx`, visible only when `userRole === 'super_admin'`. Use `Search` or `Radar` icon from lucide-react. Place after the existing nav links, before the user menu.

---

## 3. Data Flow

### Prospect Lifecycle

```
[ScoutNewProspect form]
    │
    ▼  INSERT into prospects (status='discovery')
[ScoutDashboard table]
    │
    ▼  Click "Run Scout" → POST /trigger-pipeline
[pipeline-server.ts]
    │
    ▼  spawn run-pipeline.sh --mode prospect --prospect-config ...
[Scout agent runs]
    │
    ▼  UPDATE prospects (status='scouted', scout_run_at, scout_output_path)
[ScoutDashboard polls]
    │
    ▼  Click row → ScoutReport page
[ScoutReport]
    │
    ▼  Fetch markdown via Supabase Edge Function → render
```

### Read/Write Summary

| Component | Reads | Writes |
|-----------|-------|--------|
| ScoutDashboard | `prospects` (list, poll status) | — |
| ScoutNewProspect | — | `prospects` (INSERT) |
| ScoutReport | `prospects` (single), scout markdown (edge fn) | — |
| "Run Scout" button | — | POST to pipeline-server.ts |

---

## 4. Hooks — `src/hooks/useProspects.ts`

Follow the exact pattern from `useAudits.ts`: named exports, `useQuery`/`useMutation` from `@tanstack/react-query`, throw on Supabase errors, `queryClient.invalidateQueries` on success.

### `useProspects()`

```typescript
export function useProspects() {
  return useQuery({
    queryKey: ['prospects'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('prospects')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data;
    },
  });
}
```

### `useProspect(id)`

```typescript
export function useProspect(id: string) {
  return useQuery({
    queryKey: ['prospects', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('prospects')
        .select('*')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled: !!id,
  });
}
```

### `useProspectStatus(id)`

Polls while status is `'running'` (same pattern as `useAuditStatus`):

```typescript
export function useProspectStatus(id: string, enabled = true) {
  return useQuery({
    queryKey: ['prospects', id, 'status'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('prospects')
        .select('id, status, scout_run_at, scout_output_path')
        .eq('id', id)
        .single();
      if (error) throw error;
      return data;
    },
    enabled,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status === 'running' ? 2000 : false;
    },
  });
}
```

### `useCreateProspect()`

```typescript
interface CreateProspectParams {
  name: string;
  domain: string;
  geo_type: 'city' | 'metro' | 'state' | 'national';
  target_geos: any;  // JSONB structure varies by geo_type
  topic_patterns: string[];
  state: string;
}

export function useCreateProspect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (params: CreateProspectParams) => {
      const { data, error } = await supabase
        .from('prospects')
        .insert({
          name: params.name,
          domain: params.domain,
          geo_type: params.geo_type,
          target_geos: params.target_geos,
          status: 'discovery',
        })
        .select()
        .single();
      if (error) throw error;

      // Write prospect-config.json via edge function
      // (see Section 6 — new edge function)
      const { data: { session } } = await supabase.auth.getSession();
      await supabase.functions.invoke('scout-config', {
        body: {
          action: 'write_config',
          domain: params.domain,
          config: {
            name: params.name,
            domain: params.domain,
            geo_type: params.geo_type,
            target_geos: params.target_geos,
            topic_patterns: params.topic_patterns,
            state: params.state,
          },
        },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });

      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
    },
  });
}
```

### `useRunScout()`

Triggers pipeline-server.ts:

```typescript
export function useRunScout() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ prospectId, domain }: { prospectId: string; domain: string }) => {
      // 1. Update prospect status to 'running'
      await supabase
        .from('prospects')
        .update({ status: 'running', updated_at: new Date().toISOString() })
        .eq('id', prospectId);

      // 2. Trigger pipeline server
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke('scout-config', {
        body: {
          action: 'trigger_scout',
          domain,
        },
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

### `useScoutReport(domain)`

Fetches rendered scout markdown:

```typescript
export function useScoutReport(domain: string) {
  return useQuery({
    queryKey: ['scout-report', domain],
    queryFn: async () => {
      const { data: { session } } = await supabase.auth.getSession();
      const res = await supabase.functions.invoke('scout-config', {
        body: { action: 'read_report', domain },
        headers: { Authorization: `Bearer ${session?.access_token}` },
      });
      if (res.error) throw new Error(res.error.message);
      return res.data as { markdown: string; scope: any };
    },
    enabled: !!domain,
  });
}
```

### `useDeleteProspect()`

```typescript
export function useDeleteProspect() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('prospects').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['prospects'] });
    },
  });
}
```

---

## 5. Pipeline Trigger — Exact Request Format

### Current limitation

`pipeline-server.ts` currently only accepts `{ domain, email }` and spawns `run-pipeline.sh <domain> <email>` with no mode argument. **It needs a small update** to support prospect mode.

### Required change to `pipeline-server.ts`

Add optional `mode` and `prospect_config` fields to the request body. When `mode === 'prospect'`, pass `--mode prospect --prospect-config <path>` to `run-pipeline.sh`:

```typescript
// In the request handler, after extracting domain and email:
const mode = body.mode || 'full';
const prospectConfig = body.prospect_config || '';

const args = [domain, email];
if (mode === 'prospect' && prospectConfig) {
  args.push('--mode', 'prospect', '--prospect-config', prospectConfig);
}

const child = spawn(scriptPath, args, { detached: true, stdio: 'ignore' });
```

### Request from frontend (via edge function proxy)

The frontend does NOT call pipeline-server.ts directly (it's an internal server on port 3847, not publicly routable). Instead, the `scout-config` edge function (see Section 6) proxies the trigger:

```json
POST /trigger-pipeline
Authorization: Bearer <PIPELINE_TRIGGER_SECRET>
Content-Type: application/json

{
  "domain": "idahomedicalacademy.com",
  "email": "matt@forgegrowth.ai",
  "mode": "prospect",
  "prospect_config": "audits/idahomedicalacademy.com/prospect-config.json"
}
```

---

## 6. New Edge Function: `scout-config`

**Why**: The frontend needs to (a) write `prospect-config.json` to the NanoClaw filesystem, (b) trigger the pipeline server, and (c) read the scout report markdown back. All three require access to the NanoClaw host, which the browser cannot reach directly. A single edge function proxies all three operations to the pipeline server.

**File**: `supabase/functions/scout-config/index.ts`

**Auth**: Requires valid JWT. Validates `super_admin` role via `has_role(user_id, 'super_admin')` RPC.

**Actions**:

| Action | What it does |
|--------|-------------|
| `write_config` | POSTs to pipeline server: `POST /scout-config` with config JSON. Pipeline server writes `audits/{domain}/prospect-config.json` to disk. |
| `trigger_scout` | POSTs to pipeline server: `POST /trigger-pipeline` with `mode: 'prospect'`. |
| `read_report` | POSTs to pipeline server: `POST /scout-report` with `{ domain }`. Pipeline server reads the latest scout markdown + scope.json from disk and returns them. |

### Required pipeline-server.ts additions

Add two new endpoints alongside the existing `POST /trigger-pipeline`:

**`POST /scout-config`** — Writes prospect-config.json to disk:
```typescript
// Request: { domain: string, config: ProspectConfig }
// Writes to: audits/{domain}/prospect-config.json
// Response: 200 { status: 'written', path: '...' }
```

**`POST /scout-report`** — Reads scout output from disk:
```typescript
// Request: { domain: string }
// Reads latest: audits/{domain}/scout/{latest-date}/scout-*.md + scope.json
// Response: 200 { markdown: '...', scope: {...} }
// Response: 404 { error: 'No scout report found' }
```

Both endpoints use the same Bearer token auth as `/trigger-pipeline`.

---

## 7. Page Implementations

### ScoutDashboard.tsx

**Layout**: Same as `AuditsDashboard.tsx` — `<AppLayout>` wrapper, table with status badges.

**SuperAdmin gate** (at top of component, before return):
```typescript
const { user } = useAuth();
const [userRole, setUserRole] = useState<string | null>(null);

useEffect(() => {
  if (!user) return;
  supabase.rpc('has_role', { _user_id: user.id, _role: 'super_admin' })
    .then(({ data }) => {
      if (!data) navigate('/audits', { replace: true });
      else setUserRole('super_admin');
    });
}, [user]);

if (!userRole) {
  return <AppLayout><div className="flex items-center justify-center py-12">
    <Loader2 className="h-8 w-8 animate-spin text-primary" />
  </div></AppLayout>;
}
```

**Table columns**: Domain | Name | Geo Mode | Status | Last Scout Run | Actions

**Action buttons per row**:
- "Run Scout" (`Play` icon, primary, disabled while status='running') — calls `useRunScout()`
- "View Report" (`FileText` icon, ghost, enabled when status='scouted') — navigates to `/scout/:id`
- "Delete" (`Trash2` icon, destructive, inside `AlertDialog` confirmation) — calls `useDeleteProspect()`
- "Convert to Client" (`ArrowRight` icon, outline, disabled) — **placeholder button, not implemented** (see Section 9)

**Status badge** (match existing pattern):
```typescript
function getProspectStatusBadge(status: string) {
  switch (status) {
    case 'discovery': return <Badge variant="secondary">Discovery</Badge>;
    case 'running':   return <Badge className="bg-primary text-primary-foreground animate-pulse-glow">Running</Badge>;
    case 'scouted':   return <Badge className="bg-success text-success-foreground">Scouted</Badge>;
    case 'converted': return <Badge className="bg-blue-500 text-white">Converted</Badge>;
    case 'failed':    return <Badge variant="destructive">Failed</Badge>;
    default:          return <Badge variant="secondary">{status}</Badge>;
  }
}
```

**Header area**: Title "Scout — Prospect Discovery" + "New Prospect" button (navigates to `/scout/new`).

---

### ScoutNewProspect.tsx

**Layout**: Same as `NewAudit.tsx` — `<AppLayout>`, `<Card>` with form fields, back button.

**Same SuperAdmin gate** as ScoutDashboard (self-redirect if not super_admin).

**Form fields**:

| Field | Component | Notes |
|-------|-----------|-------|
| Business Name | `Input` | Required |
| Domain | `Input` | Required, lowercase, validated against domain regex |
| Geo Mode | `RadioGroup` with 4 options | `city`, `metro`, `state`, `national` |
| State (city/metro modes) | `Select` from `US_STATES` | Shown when geo_mode is `city` or `metro` |
| Cities (city mode) | `Input` | Comma-separated, shown when geo_mode is `city` |
| Metros (metro mode) | `Input` | Comma-separated, shown when geo_mode is `metro` |
| States (state mode) | Multi-`Select` or comma-separated `Input` | Shown when geo_mode is `state` |
| Topic Patterns | `Input` | Comma-separated (e.g., "emt, certification, training") |
| State Abbreviation | `Input` | Used in keyword construction (e.g., "ID", "WA") |

**GeoModeSelector component** (`components/scout/GeoModeSelector.tsx`):
- Receives `geoMode`, `onGeoModeChange`, `geoData`, `onGeoDataChange`
- Renders `RadioGroup` for mode selection
- Conditionally renders the appropriate input fields based on mode
- Builds the `target_geos` JSONB structure internally

**Submit**: Calls `useCreateProspect()`. On success: `navigate('/scout')` with toast.

**Styling**: Match `NewAudit.tsx` exactly — same `Input` className, same `Select` className, same `Button` className, same `Card` structure.

---

### ScoutReport.tsx

**Layout**: `<AppLayout>`, two-column on large screens.

**Left column (2/3 width)**: Scout report markdown rendered via `react-markdown` with `markdownComponents` from `components/audit/MarkdownRenderer.tsx`.

**Right column (1/3 width)**:
- **Prospect Info Card**: Name, domain, geo_mode, target geos, scout date, cost
- **Gap Summary Card** (`GapSummaryCard.tsx`): Reads `scope.json` data — total gaps, defending, weak, total opportunity volume. Shows top 10 gap keywords by volume in a mini table.
- **"Convert to Client" button** — placeholder, disabled (see Section 9)

**Data loading**: `useProspect(id)` for metadata, `useScoutReport(prospect.domain)` for markdown + scope.

**Loading state**: Same `Loader2` spinner pattern as `AuditRunning.tsx`.

**Error state**: Same `AlertCircle` + error card pattern as `AuditRunning.tsx`.

---

## 8. Access Control Implementation

### Role Check Pattern

Until the full RBAC system is built (AuthContext `userRole` property), Scout pages check the role directly via RPC. This matches the pattern specified in RBAC_SPEC.md for `AdminUsers`:

```typescript
// At the top of each Scout page component:
const { user } = useAuth();
const navigate = useNavigate();
const [authorized, setAuthorized] = useState(false);

useEffect(() => {
  if (!user) return;
  supabase.rpc('has_role', { _user_id: user.id, _role: 'super_admin' })
    .then(({ data }) => {
      if (!data) {
        navigate('/audits', { replace: true });
      } else {
        setAuthorized(true);
      }
    });
}, [user, navigate]);

if (!authorized) {
  return (
    <AppLayout>
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    </AppLayout>
  );
}
```

### Nav Visibility

In `Header.tsx`, conditionally show the Scout link:

```typescript
// Same RPC check, cached in local state
{isSuperAdmin && (
  <Link to="/scout" className="...existing nav link classes...">
    <Radar className="h-4 w-4 mr-1" />
    Scout
  </Link>
)}
```

### Edge Function Auth

The `scout-config` edge function validates super_admin:

```typescript
const { data: { user } } = await supabaseClient.auth.getUser();
const { data: isAdmin } = await supabaseClient.rpc('has_role', {
  _user_id: user.id,
  _role: 'super_admin',
});
if (!isAdmin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403 });
```

### RLS on prospects table

Add a policy so only super_admin can read/write prospects:

```sql
ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "super_admin_full_access" ON public.prospects
  FOR ALL
  USING (public.has_role(auth.uid(), 'super_admin'))
  WITH CHECK (public.has_role(auth.uid(), 'super_admin'));
```

This migration should be added alongside the Scout UI deployment.

---

## 9. Future Hook: Convert to Client

**Location**: `ScoutDashboard.tsx` (table action button) and `ScoutReport.tsx` (sidebar button).

**Current state**: Render a disabled `Button` with `ArrowRight` icon and tooltip "Coming soon":

```tsx
<Button variant="outline" size="sm" disabled title="Convert to Client — coming soon">
  <ArrowRight className="h-4 w-4 mr-1" />
  Convert
</Button>
```

**When implemented**, this button will:
1. Open a confirmation dialog showing the prospect's geo data that will map to the audit
2. Call a `useConvertProspect()` mutation that:
   - Creates an `audits` row with `geo_mode` and `market_geos` mapped from the prospect
   - Maps: prospect `geo_type` → audit `geo_mode`, prospect `target_geos` → audit `market_geos`
   - Updates `prospects.status` to `'converted'` and sets `converted_to_audit_id`
3. Navigate to `/audits/:newAuditId/running` or the new audit form for final review

**No restructuring needed** — the button placeholder and the hook signature are sufficient anchor points.

---

## 10. Types

Add to `src/types/database.ts` in the `Tables` section:

```typescript
prospects: {
  Row: {
    id: string;
    name: string;
    domain: string;
    geo_type: string;
    target_geos: any;
    status: string;
    scout_run_at: string | null;
    scout_output_path: string | null;
    converted_to_audit_id: string | null;
    created_at: string;
    updated_at: string;
  };
  Insert: {
    id?: string;
    name: string;
    domain: string;
    geo_type?: string;
    target_geos?: any;
    status?: string;
    scout_run_at?: string | null;
    scout_output_path?: string | null;
    converted_to_audit_id?: string | null;
    created_at?: string;
    updated_at?: string;
  };
  Update: {
    id?: string;
    name?: string;
    domain?: string;
    geo_type?: string;
    target_geos?: any;
    status?: string;
    scout_run_at?: string | null;
    scout_output_path?: string | null;
    converted_to_audit_id?: string | null;
    updated_at?: string;
  };
};
```

---

## 11. Definition of Done

### Backend (NanoClaw side)

- [ ] `pipeline-server.ts` accepts `mode` and `prospect_config` in request body
- [ ] `pipeline-server.ts` has `POST /scout-config` endpoint (write prospect config to disk)
- [ ] `pipeline-server.ts` has `POST /scout-report` endpoint (read scout markdown + scope.json)
- [ ] RLS policy on `prospects` table restricting to super_admin
- [ ] `prospects` type added to `database.ts`

### Edge Function

- [ ] `scout-config` edge function created with `write_config`, `trigger_scout`, `read_report` actions
- [ ] Edge function validates super_admin role before all actions

### Frontend Pages

- [ ] `ScoutDashboard.tsx` — lists prospects, status badges, Run/View/Delete actions
- [ ] `ScoutNewProspect.tsx` — form with geo mode selector, creates prospect + writes config
- [ ] `ScoutReport.tsx` — renders scout markdown, shows gap summary card
- [ ] All three pages gate on super_admin (self-redirect if not)

### Components

- [ ] `GeoModeSelector.tsx` — radio group + conditional geo inputs
- [ ] `ProspectStatusBadge.tsx` — status badge helper
- [ ] `GapSummaryCard.tsx` — gap stats from scope.json
- [ ] `ScoutMarkdownViewer.tsx` — renders markdown with `markdownComponents`

### Navigation

- [ ] "Scout" link in Header.tsx, visible only to super_admin
- [ ] Routes added to App.tsx (3 routes, all protected)

### Hooks

- [ ] `useProspects()` — list all
- [ ] `useProspect(id)` — single prospect
- [ ] `useProspectStatus(id)` — poll while running
- [ ] `useCreateProspect()` — insert + write config
- [ ] `useRunScout()` — trigger pipeline
- [ ] `useScoutReport(domain)` — fetch markdown + scope
- [ ] `useDeleteProspect()` — delete with confirmation

### Integration Tests

- [ ] Create prospect → verify row in Supabase
- [ ] Run Scout → verify pipeline spawns with `--mode prospect`
- [ ] View report → verify markdown renders
- [ ] Non-super_admin user → verify redirect to /audits
- [ ] Duplicate domain → verify unique constraint error shown in toast
