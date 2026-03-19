# Session 2: Scout Narrative + Review Gate UI

## Context

The pipeline backend now supports two new capabilities deployed to production:

1. **Scout Prospect Narrative** — After running Scout, the pipeline generates `prospect-narrative.md` — a plain-language outreach document for business owners (3 sections: "Where You're Winning", "Where Demand Is Escaping You", "What a Full Analysis Would Reveal"). The `scout-config` edge function's `read_report` action now returns a `narrative` field alongside `markdown` and `scope`.

2. **Pipeline Review Gate** — An opt-in pause after Phase 1b (Strategy Brief). When `audits.review_gate_enabled = true` and the pipeline runs in full mode, it pauses with `audits.status = 'awaiting_review'`. The user reviews the strategy brief, optionally adds annotations, then resumes via the `pipeline-controls` edge function (`action: 'resume_pipeline'`). The edge function appends annotations to `audits.client_context.out_of_scope`, sets status back to `running`, and triggers the pipeline with `start_from: '1b'`.

Both edge functions (`pipeline-controls` and `scout-config`) are already deployed with these changes.

## Changes Required

### 1. Add `awaiting_review` to `AuditStatus` type

**File:** `src/types/database.ts` (line 9)

Current:
```typescript
export type AuditStatus = 'draft' | 'running' | 'completed' | 'failed';
```

Change to:
```typescript
export type AuditStatus = 'draft' | 'running' | 'completed' | 'failed' | 'awaiting_review';
```

### 2. Add status badge for `awaiting_review`

**File:** `src/pages/AuditsDashboard.tsx`

In `getStatusBadge()` (around line 17-29), add a case before `default`:

```typescript
case 'awaiting_review':
  return <Badge className="bg-amber-500/15 text-amber-600 border-amber-500/30">Awaiting Review</Badge>;
```

### 3. Add dashboard routing for `awaiting_review`

**File:** `src/pages/AuditsDashboard.tsx`

In the `<Link>` at around line 153-156, add `awaiting_review` routing to Settings:

Current:
```typescript
to={audit.status === 'completed' ? `/audits/${audit.id}/overview`
  : audit.status === 'draft' ? `/audits/${audit.id}/settings`
  : `/audits/${audit.id}/running`}
```

Change to:
```typescript
to={audit.status === 'completed' ? `/audits/${audit.id}/overview`
  : audit.status === 'draft' ? `/audits/${audit.id}/settings`
  : audit.status === 'awaiting_review' ? `/audits/${audit.id}/settings`
  : `/audits/${audit.id}/running`}
```

### 4. Add `ReviewBanner` to Settings page

**File:** `src/pages/audit/AuditSettings.tsx`

Add a new `ReviewBanner` component (similar pattern to the existing `DraftBanner`) that shows when `audit?.status === 'awaiting_review'`. Place it right below the existing `DraftBanner` render:

```tsx
{audit?.status === 'awaiting_review' && <ReviewBanner auditId={auditId!} domain={audit.domain} />}
```

**ReviewBanner design:**

- Amber/warning-toned card (not destructive red, not neutral gray)
- Icon: `Eye` or `PauseCircle` from lucide-react
- Heading: "Strategy Brief Review"
- Subtext: "The pipeline paused after generating the Strategy Brief. Review the strategic framing below, add any corrections, then approve to continue."
- **Strategy Brief viewer**: Fetch `strategy_brief.md` from the pipeline server using the existing `supabase.functions.invoke('pipeline-controls')` pattern — make a call to the pipeline server's `/artifact` endpoint via the `scout-config` or `pipeline-controls` edge function, OR use the `artifact` edge function if available. Simplest approach: use `supabase.functions.invoke('scout-config', { body: { action: 'read_report', domain } })` pattern but for the artifact — BUT the strategy brief lives in `audits/{domain}/research/{date}/strategy_brief.md`, not the scout dir. **Best approach**: call the pipeline server `/artifact` endpoint with `{ domain, file: 'research/*/strategy_brief.md' }`. For MVP, just show a message "Review the Strategy Brief in your pipeline artifacts" and focus on the annotation + resume flow.
- **Annotations textarea**: Optional text input labeled "Corrections or constraints" with placeholder "e.g., Exclude residential services, focus on commercial HVAC only"
- **Two buttons**:
  - "Approve & Resume Pipeline" (primary) — calls `resumePipeline` mutation
  - "Resume without changes" (ghost) — calls `resumePipeline` without annotations

### 5. Add `resumePipeline` mutation to `usePipelineControls`

**File:** `src/hooks/useAuditSettings.ts`

Add a new mutation to the `usePipelineControls` hook (after `rerunPipeline`, around line 197):

```typescript
const resumePipeline = useMutation({
  mutationFn: async ({ domain, annotations }: { domain: string; annotations?: string }) => {
    const { data, error } = await supabase.functions.invoke('pipeline-controls', {
      body: {
        action: 'resume_pipeline',
        audit_id: auditId,
        domain,
        email: user?.email,
        annotations: annotations || undefined,
      },
    });
    if (error) throw error;
    return data;
  },
  onSuccess: () => {
    queryClient.invalidateQueries({ queryKey: ['audit', auditId] });
    queryClient.invalidateQueries({ queryKey: ['audit-status', auditId] });
    toast({
      title: 'Pipeline resumed',
      description: 'The pipeline will continue from keyword research. Check back in 15-20 minutes.',
    });
  },
  onError: (err: Error) => {
    toast({ title: 'Resume failed', description: err.message, variant: 'destructive' });
  },
});
```

Return it alongside the existing mutations:
```typescript
return { recanonicalize, refreshRankings, rerunPipeline, resumePipeline };
```

### 6. Add `review_gate_enabled` toggle to Settings page

**File:** `src/pages/audit/AuditSettings.tsx`

In the Pipeline Controls section (where Re-canonicalize, Refresh Rankings, Re-run Pipeline buttons are), add a toggle:

- Label: "Review Gate"
- Description: "Pause pipeline after Strategy Brief for manual review before continuing"
- Switch component that reads/writes `audits.review_gate_enabled`
- Use a simple Supabase update: `supabase.from('audits').update({ review_gate_enabled: value }).eq('id', auditId)`

### 7. Display Scout Narrative on ScoutReport page

**File:** `src/pages/ScoutReport.tsx`

The `useScoutReport` hook returns data from the `scout-config` edge function's `read_report` action. The response now includes a `narrative` field.

**Update the type** in `src/hooks/useProspects.ts` (line 180):

Current:
```typescript
return res.data as { markdown: string; scope: any };
```

Change to:
```typescript
return res.data as { markdown: string; scope: any; narrative?: string };
```

**Add narrative display** in `src/pages/ScoutReport.tsx`:

Below the existing scout report Card (after the `</Card>` around line 98), add a second card that shows the prospect narrative when available:

```tsx
{report?.narrative && (
  <Card className="border-border bg-card mt-6">
    <CardHeader>
      <CardTitle className="text-foreground">Prospect Outreach Summary</CardTitle>
      <p className="text-sm text-muted-foreground">
        Plain-language overview for sharing with the business owner
      </p>
    </CardHeader>
    <CardContent>
      <ScoutMarkdownViewer markdown={report.narrative} />
    </CardContent>
  </Card>
)}
```

This goes inside the `lg:col-span-2` main content column, below the scout report card. The narrative renders using the same `ScoutMarkdownViewer` component (react-markdown + remark-gfm).

## Edge Function Contract (already deployed)

### `pipeline-controls` — `resume_pipeline` action

```typescript
// Request
{
  action: 'resume_pipeline',
  audit_id: string,    // Required
  domain: string,      // Required
  email: string,       // Required (user's email)
  annotations?: string // Optional — appended to client_context.out_of_scope
}

// Response (200)
{ success: true, start_from: '1b' }

// Response (400)
{ error: 'audit_id, domain, and email are required' }

// Response (502)
{ error: 'Pipeline trigger failed' }
```

### `scout-config` — `read_report` action (updated)

```typescript
// Response now includes narrative field
{
  markdown: string,   // Full scout report
  scope: object,      // scope.json data
  date: string,       // Scout run date
  narrative: string   // Prospect narrative (empty string if not generated)
}
```

## What NOT to change

- Do NOT modify any edge functions — they are already deployed
- Do NOT modify pipeline server or pipeline scripts
- Do NOT add new edge functions
- Do NOT change the `audits` table schema (the `review_gate_enabled` column and `awaiting_review` status value already exist in the database)
