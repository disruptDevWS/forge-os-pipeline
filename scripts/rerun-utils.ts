/**
 * rerun-utils.ts — Shared utilities for pipeline re-run stability.
 *
 * Imported by both sync-to-dashboard.ts and pipeline-generate.ts.
 */

export type RerunScenario = 'first_run' | 'strategic_rerun' | 'failure_resume';

/**
 * A page is "committed" if any human or downstream process has acted on it.
 * Committed pages are protected during re-runs — syncMichael won't overwrite them.
 */
export const isCommitted = (page: {
  status: string;
  source?: string | null;
  published_at?: string | null;
}): boolean =>
  page.status !== 'not_started' ||
  page.source === 'cluster_strategy' ||
  page.source === 'manual' ||
  page.published_at != null;

/**
 * Phase ordering — mirrors PHASE_ORDER in run-pipeline.sh.
 * Used for startFrom comparison in detectRerunScenario.
 */
export const PHASE_ORDER = [
  '1', '1a', '1c', '1b', '2', '3', '3b', '3c', '3d',
  '4', '5', '6', '6.5', '6b', '6c', '6d',
] as const;

/**
 * Returns the index of a phase in PHASE_ORDER, or -1 if not found.
 */
export function phaseIndex(phase: string): number {
  return PHASE_ORDER.indexOf(phase as typeof PHASE_ORDER[number]);
}
