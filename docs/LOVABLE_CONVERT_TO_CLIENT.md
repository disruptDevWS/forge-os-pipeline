# Convert-to-Client — Lovable Implementation Instructions

Wire the prospect-to-client conversion flow in the Forge Growth dashboard. When a prospect has been scouted, the user clicks "Convert to Client" which creates an audit, links the prospect, and triggers the full pipeline.

## Prerequisites

- `prospects` table exists with `status`, `converted_to_audit_id` columns
- `audits` table exists with all required fields
- `run-audit` Edge Function deployed (thin trigger → pipeline server)
- Pipeline server running on NanoClaw host

---

## A. `useConvertProspect()` Hook

Create in `src/hooks/useProspects.ts` (or a new file `src/hooks/useConvertProspect.ts`).

```typescript
async function convertProspect(
  prospectId: string,
  serviceKey: string // from modal dropdown
) {
  // 1. Read the prospect
  const { data: prospect } = await supabase
    .from('prospects')
    .select('*')
    .eq('id', prospectId)
    .single();

  if (!prospect) throw new Error('Prospect not found');

  // 2. Extract geo fields for backward compat
  const firstGeo = prospect.target_geos?.[0];
  const marketCity = firstGeo?.metros?.[0] ?? '';
  const marketState = firstGeo?.state ?? '';

  // 3. INSERT into audits
  const { data: audit, error: auditError } = await supabase
    .from('audits')
    .insert({
      domain: prospect.domain,
      business_name: prospect.name,
      service_key: serviceKey,
      geo_mode: prospect.geo_type,        // same enum: 'city' | 'metro' | 'state' | 'national'
      market_geos: prospect.target_geos,  // same JSONB structure
      market_city: marketCity,             // backward compat
      market_state: marketState,           // backward compat
      user_id: (await supabase.auth.getUser()).data.user?.id,
      status: 'pending',
    })
    .select()
    .single();

  if (auditError) throw auditError;

  // 4. UPDATE prospect → converted
  await supabase
    .from('prospects')
    .update({
      status: 'converted',
      converted_to_audit_id: audit.id,
    })
    .eq('id', prospectId);

  // 5. Invoke run-audit Edge Function
  const { error: fnError } = await supabase.functions.invoke('run-audit', {
    body: { audit_id: audit.id },
  });

  if (fnError) {
    console.error('run-audit invocation failed:', fnError);
    // Don't throw — audit is created, pipeline can be retried manually
  }

  return audit;
}
```

---

## B. Field Mapping (Prospect → Audit)

| Prospect Field | Audit Field | Transform |
|----------------|-------------|-----------|
| `domain` | `domain` | Direct |
| `name` | `business_name` | Direct |
| `geo_type` | `geo_mode` | Direct (same enum) |
| `target_geos` | `market_geos` | Direct (same JSONB) |
| `target_geos[0].metros[0]` | `market_city` | First metro for backward compat |
| `target_geos[0].state` | `market_state` | First state for backward compat |
| *(user input from modal)* | `service_key` | Dropdown selection |

---

## C. ConvertToClientModal Component

Modal shown when user clicks "Convert to Client" button.

**Key elements:**
1. **Service category dropdown** — maps to `service_key` on the `audits` table
2. Pre-populate the dropdown default from Scout's `business_type` in `scope.json`

**How to get the default service_key:**

```typescript
// Read scope.json via the read_report Supabase storage action,
// or fetch from the scout_output_path on the prospect record
const scopePath = prospect.scout_output_path; // e.g., "scout/2026-03-12/scope.json"
// Fetch scope.json from disk via an API route or Supabase storage
// Extract business_type and map to closest service_key

// Service key options (from benchmarks table):
const SERVICE_KEYS = [
  'hvac', 'plumbing', 'electrical', 'roofing', 'restoration',
  'garage_doors', 'landscaping', 'pest_control', 'fencing',
  'tree_service', 'remodeling', 'medical_training', 'other'
];
```

**Modal layout:**
- Header: "Convert {prospect.name} to Client"
- Domain display (read-only): `prospect.domain`
- Service category dropdown (required): default from `business_type` mapping
- Geo summary (read-only): shows `prospect.target_geos` formatted
- Convert button → calls `useConvertProspect` mutation
- Cancel button

---

## D. Enable Convert Button

The "Convert to Client" button should only be visible/enabled when:

```typescript
prospect.status === 'scouted'
```

Other statuses:
- `discovery` — Scout hasn't run yet, button disabled
- `scouted` — Scout complete, button enabled
- `converted` — Already converted, show "View Audit" link instead

---

## E. Post-Conversion Navigation

After successful conversion, navigate to the running audit:

```typescript
const audit = await convertProspect(prospectId, serviceKey);
navigate(`/audits/${audit.id}/running`);
```

---

## How the Pipeline Picks Up Scout Data

No additional wiring needed. The pipeline automatically:

1. **KeywordResearch (Phase 2)** loads `scope.json` from `audits/{domain}/scout/{date}/` using `findLatestDatedDir()`. Scout priors are injected into the Haiku extraction prompt and gap keywords are pre-seeded into the matrix.
2. **run-audit Edge Function** triggers the full pipeline (Phases 1–6c) via HTTP POST to the pipeline server.
3. The prospect's `target_geos` and `geo_type` flow through to the audit's `geo_mode` and `market_geos`, so all phases respect the geographic scope discovered during scouting.
