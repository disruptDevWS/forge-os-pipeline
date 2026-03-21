# Contributing

## Source Code Changes

**Accepted:** Bug fixes, security fixes, simplifications, performance improvements.

## Pipeline Phase Guidelines

When adding or modifying a pipeline phase:

1. Follow the single-shot prompt template pattern in `scripts/pipeline-generate.ts`
2. Use "YOUR ENTIRE RESPONSE IS THE [ARTIFACT]" framing to prevent narration
3. Validate output with `validateArtifact()` before writing to disk
4. If the phase writes to Supabase, add a sync function in `scripts/sync-to-dashboard.ts`
5. Update `docs/PIPELINE.md` — this is a contract, not optional documentation

## Testing

Run `npx tsc --noEmit` and `npx vitest run` before submitting.
