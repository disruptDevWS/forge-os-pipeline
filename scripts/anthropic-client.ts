/**
 * anthropic-client.ts — Drop-in replacements for callClaude/callClaudeAsync
 *
 * Uses @anthropic-ai/sdk directly instead of spawning the Claude CLI binary.
 * Eliminates: binary dependency, env var stripping hack, spawn fragility,
 * stripClaudePreamble, 120s spawnSync timeout cap.
 */

import Anthropic from '@anthropic-ai/sdk';

// ── Model mapping ─────────────────────────────────────────────

const MODEL_MAP: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-6',
};

function resolveModel(shortName: string): string {
  return MODEL_MAP[shortName] ?? shortName;
}

// ── Max tokens per phase ──────────────────────────────────────

export const PHASE_MAX_TOKENS: Record<string, number> = {
  dwight: 16384,
  jim: 16384,
  michael: 16384,
  gap: 8192,
  'keyword-research-extract': 4096,
  'keyword-research-synth': 16384,
  canonicalize: 4096,
  competitors: 4096,
  validator: 16384,
  scout_topic: 4096,
  scout_report: 16384,
  brief: 16384,
  content: 16384,
  qa: 4096,
  prospect_narrative: 2048,
  default: 8192,
};

// ── Singleton client ──────────────────────────────────────────

let _client: Anthropic | null = null;

function getClient(apiKey?: string): Anthropic {
  if (!_client) {
    _client = new Anthropic({
      apiKey: apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_KEY,
    });
  }
  return _client;
}

/**
 * Initialize the client with a specific API key.
 * Call this once at startup if loading from .env file.
 */
export function initAnthropicClient(apiKey: string): void {
  _client = new Anthropic({ apiKey });
}

// ── Truncation detection ─────────────────────────────────────

export class TruncationError extends Error {
  output: string;
  constructor(message: string, output: string) {
    super(message);
    this.name = 'TruncationError';
    this.output = output;
  }
}

// ── Core call function ────────────────────────────────────────

export interface CallClaudeOptions {
  model?: string;       // 'sonnet', 'haiku', or full model ID
  maxTokens?: number;   // override max_tokens
  phase?: string;       // phase name for max_tokens lookup
  timeoutMs?: number;   // request timeout (default: 600_000)
  warnOnTruncation?: boolean; // throw TruncationError if stop_reason === 'max_tokens'
}

/**
 * Call Claude via the Anthropic SDK.
 * Drop-in replacement for both callClaude() and callClaudeAsync().
 */
export async function callClaude(
  prompt: string,
  modelOrOptions: string | CallClaudeOptions = 'sonnet',
): Promise<string> {
  const opts: CallClaudeOptions =
    typeof modelOrOptions === 'string' ? { model: modelOrOptions } : modelOrOptions;

  const model = resolveModel(opts.model ?? 'sonnet');
  const maxTokens = opts.maxTokens
    ?? PHASE_MAX_TOKENS[opts.phase ?? '']
    ?? PHASE_MAX_TOKENS.default;
  const timeoutMs = opts.timeoutMs ?? 600_000;

  const client = getClient();

  const response = await client.messages.create(
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    },
    { timeout: timeoutMs },
  );

  // Extract text from response
  const textBlocks = response.content.filter((b) => b.type === 'text');
  const output = textBlocks.map((b) => b.text).join('\n').trim();

  if (!output) {
    throw new Error(
      `Anthropic API returned empty response (model: ${model}, stop_reason: ${response.stop_reason})`,
    );
  }

  if (output.startsWith('Error:')) {
    throw new Error(`Anthropic API returned error: ${output.slice(0, 200)}`);
  }

  // Truncation detection
  if (response.stop_reason === 'max_tokens') {
    const phase = opts.phase ?? 'unknown';
    const tail = output.slice(-100);
    console.warn(`  [truncation] Phase "${phase}" hit max_tokens (${maxTokens}). Last 100 chars: …${tail}`);
    if (opts.warnOnTruncation) {
      throw new TruncationError(
        `Phase "${phase}" output truncated at ${maxTokens} tokens`,
        output,
      );
    }
  }

  return output;
}

/**
 * Async alias — identical to callClaude since SDK is async by default.
 * Kept for API compatibility during migration.
 */
export const callClaudeAsync = callClaude;
