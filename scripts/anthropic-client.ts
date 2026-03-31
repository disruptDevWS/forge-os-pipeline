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
  gap: 12288,
  'keyword-research-extract': 4096,
  'keyword-research-synth': 16384,
  canonicalize: 4096,
  competitors: 4096,
  validator: 16384,
  scout_topic: 4096,
  scout_report: 16384,
  brief: 16384,
  content: 65536,
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

// ── Retry helper (DATA-6) ────────────────────────────────────

const RETRY_MAX_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1000;

function isRetryable(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    // 429 = rate limited, 529 = overloaded, 5xx = server error
    return error.status === 429 || error.status === 529 || (error.status >= 500 && error.status < 600);
  }
  // Network errors (fetch failures, timeouts)
  if (error instanceof Error && (error.message.includes('ECONNRESET') || error.message.includes('fetch failed') || error.message.includes('ETIMEDOUT'))) {
    return true;
  }
  return false;
}

async function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 * Retries on 429/529/5xx with exponential backoff (1s, 4s, 16s).
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
  const phase = opts.phase ?? 'unknown';

  const client = getClient();

  // Anthropic API requires streaming for requests that may exceed 10 minutes
  const useStreaming = maxTokens > 16384;

  let lastError: unknown;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      const params = {
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user' as const, content: prompt }],
      };

      const response = useStreaming
        ? await client.messages.stream(params, { timeout: timeoutMs }).finalMessage()
        : await client.messages.create(params, { timeout: timeoutMs });

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
    } catch (error) {
      lastError = error;
      if (attempt < RETRY_MAX_ATTEMPTS && isRetryable(error)) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(4, attempt - 1); // 1s, 4s, 16s
        const status = error instanceof Anthropic.APIError ? error.status : 'network';
        console.warn(`  [retry] Phase "${phase}" attempt ${attempt}/${RETRY_MAX_ATTEMPTS} failed (${status}). Retrying in ${delay}ms...`);
        await sleepMs(delay);
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

/**
 * Async alias — identical to callClaude since SDK is async by default.
 * Kept for API compatibility during migration.
 */
export const callClaudeAsync = callClaude;
