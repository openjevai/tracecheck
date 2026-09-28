import { z } from 'zod';
import { assertSafeOutbound } from './safety.js';
import { deadline } from './deadline.js';
import type { Choice, Evaluator, Response, Question, TypedResponse, TypedEvaluator } from './domain.js';

export const answerSchema = z.object({
  type: z.literal('choice'), choice: z.string(), confidence: z.number().min(0).max(1),
  probabilities: z.record(z.string(), z.number().min(0).max(1)),
});
const responseSchema = z.object({
  model: z.string().min(1), answers: z.record(z.string(), z.discriminatedUnion('type', [answerSchema,
    z.object({ type: z.literal('noul'), noul: z.number().min(0).max(1) }),
    z.object({ type: z.literal('score'), score: z.number().nonnegative(), confidence: z.number().min(0).max(1),
      probabilities: z.record(z.string(), z.number().min(0).max(1)), legend: z.record(z.string(), z.string()) }),
  ])),
  usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
});

async function boundedJson(response: globalThis.Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Jev returned an empty response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw new Error('Jev response exceeded the 512 KB response budget.');
      chunks.push(value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error('Jev returned invalid JSON; review is incomplete.'); }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export const TYPESAFE_BASE_URL = 'https://api.typesafe.ai';
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api';
export const OPENJEV_BASE_URL = 'https://api.openjev.sh';
export const DEFAULT_MODEL = 'jev-latest';
export const OPENJEV_MODEL = 'openjev';
export const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_TIMEOUT_MS = 3_600_000;
/** Review requests in flight at once unless JEV_CONCURRENCY or the configuration file sets another limit. */
export const DEFAULT_CONCURRENCY = 4;
const MAX_CONCURRENCY = 16;
const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUSES = [429, 500, 502, 503, 504, 529];
/** Environment variables that select the provider, credential, model, request timeout, and request concurrency. */
export const PROVIDER_ENVIRONMENT = ['JEV_PROVIDER', 'JEV_API_KEY', 'TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'OPENJEV_API_KEY', 'TYPESAFE_BASE_URL', 'JEV_MODEL', 'JEV_TIMEOUT_MS', 'JEV_CONCURRENCY'] as const;

export type JevSettings = { apiKey: string; baseUrl: string; model: string; timeoutMs: number; concurrency: number };
/** Model, request timeout, and request concurrency from the project configuration file; the environment overrides each. */
export type ConfiguredJevSettings = { model?: string; timeoutMs?: number; concurrency?: number };
export const modelSchema = z.string().trim().min(1);
export const requestTimeoutSchema = z.number().int().positive().max(MAX_TIMEOUT_MS);
export const requestConcurrencySchema = z.number().int().positive().max(MAX_CONCURRENCY);

/**
 * Resolves provider settings from the environment. A TypeSafe key takes precedence over an
 * OpenRouter key. OpenRouter serves TypeSafe's System One API, so only the base URL differs.
 * An explicit TYPESAFE_BASE_URL always wins. The credential and endpoint come only from the environment;
 * the configured model, request timeout, and request concurrency apply when the environment does not set them.
 *
 * OpenJEV is a free community gateway to the same Jev model. Set JEV_PROVIDER=openjev to use it
 * explicitly, or set only OPENJEV_API_KEY (with no TypeSafe or OpenRouter key) to select it automatically.
 * TypeSafe stays the default: anyone with a TypeSafe key sees zero behaviour change.
 */
export function jevSettings(env: NodeJS.ProcessEnv = process.env, configured: ConfiguredJevSettings = {}): JevSettings {
  const provider = env.JEV_PROVIDER?.trim().toLowerCase();
  const typesafeKey = env.JEV_API_KEY?.trim() || env.TYPESAFE_API_KEY?.trim();
  const openRouterKey = env.OPENROUTER_API_KEY?.trim();
  const openjevKey = env.OPENJEV_API_KEY?.trim();
  const timeoutMs = wholeNumber(env.JEV_TIMEOUT_MS, MAX_TIMEOUT_MS, `JEV_TIMEOUT_MS must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}.`)
    ?? configured.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const concurrency = wholeNumber(env.JEV_CONCURRENCY, MAX_CONCURRENCY, `JEV_CONCURRENCY must be a whole number from 1 to ${MAX_CONCURRENCY}.`)
    ?? configured.concurrency ?? DEFAULT_CONCURRENCY;

  // OpenJEV: explicit JEV_PROVIDER=openjev, or no TypeSafe/OpenRouter key but OPENJEV_API_KEY is set.
  const usingOpenjev = provider === 'openjev' || (!provider && !typesafeKey && !openRouterKey && !!openjevKey);
  if (usingOpenjev) {
    return {
      apiKey: openjevKey || typesafeKey || openRouterKey || '',
      baseUrl: env.TYPESAFE_BASE_URL?.trim() || OPENJEV_BASE_URL,
      model: env.JEV_MODEL?.trim() || configured.model || OPENJEV_MODEL,
      timeoutMs, concurrency,
    };
  }

  // TypeSafe (default) or OpenRouter: unchanged.
  return {
    apiKey: typesafeKey || openRouterKey || '',
    baseUrl: env.TYPESAFE_BASE_URL?.trim() || (!typesafeKey && openRouterKey ? OPENROUTER_BASE_URL : TYPESAFE_BASE_URL),
    model: env.JEV_MODEL?.trim() || configured.model || DEFAULT_MODEL,
    timeoutMs, concurrency,
  };
}

function wholeNumber(value: string | undefined, max: number, message: string): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (!/^[1-9]\d*$/.test(text) || Number(text) > max) throw new Error(message);
  return Number(text);
}

export function jevFromEnv(signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env): Jev {
  return new Jev({ ...jevSettings(env), signal });
}

/** The provider variables that are set, for forwarding to a child process. */
export function providerEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return Object.fromEntries(PROVIDER_ENVIRONMENT.flatMap(name => env[name] ? [[name, env[name]]] : []));
}

function systemOneEndpoint(baseUrl: string): string {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('TYPESAFE_BASE_URL must be an absolute URL.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The API key travels in a header, so it must never reach a remote host in plain text.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('TYPESAFE_BASE_URL must use HTTPS unless it points to a loopback host.');
  }
  if (url.username || url.password || /[?#]/.test(baseUrl)) {
    throw new Error('TYPESAFE_BASE_URL must not contain credentials, a query, or a fragment.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}/v1/systemone`;
}

export class Jev implements Evaluator, TypedEvaluator {
  readonly model: string;
  readonly endpoint: string;
  constructor(private options: { apiKey: string; model?: string; baseUrl?: string; fetch?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }) {
    if (!options.apiKey.trim()) throw new Error('Set JEV_API_KEY, TYPESAFE_API_KEY, OPENJEV_API_KEY, or OPENROUTER_API_KEY to run review, verify, or assess. Preview works without a key.');
    this.model = options.model ?? DEFAULT_MODEL;
    this.endpoint = systemOneEndpoint(options.baseUrl ?? TYPESAFE_BASE_URL);
  }

  async evaluate(state: unknown, questions: Record<string, Choice>, signal?: AbortSignal): Promise<Response>;
  async evaluate(state: unknown, questions: Record<string, Question>, signal?: AbortSignal): Promise<TypedResponse>;
  /** Aborting the client's signal or the per-call `request` signal cancels the request, including its retries. */
  async evaluate(state: unknown, questions: Record<string, Question>, request?: AbortSignal): Promise<TypedResponse> {
    assertSafeOutbound(state);
    const body = JSON.stringify({ model: this.model, state, questions });
    if (Buffer.byteLength(body) > 180_000) throw new Error('Review request exceeds the local 180 KB request budget. Reduce the review scope.');
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timeout = deadline(timeoutMs, `Jev request timed out after ${timeoutMs} ms. Set JEV_TIMEOUT_MS to allow more time.`);
    const callers = [this.options.signal, request].filter(value => value !== undefined);
    const caller = callers.length > 1 ? AbortSignal.any(callers) : callers[0];
    const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
    try {
      return await this.send(body, questions, signal);
    } catch (error) {
      // Report the limit that stopped the request rather than the error it caused downstream.
      if (caller?.aborted) throw caller.reason;
      if (timeout.aborted) throw timeout.reason;
      throw error;
    }
  }

  private async send(body: string, questions: Record<string, Question>, signal: AbortSignal): Promise<TypedResponse> {
    const request = this.options.fetch ?? fetch;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      let response: globalThis.Response;
      try {
        response = await request(this.endpoint, {
          method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' }, body, signal,
        });
      } catch (error) {
        // Connection resets, DNS failures, and TLS errors reject fetch without a response.
        if (signal.aborted || attempt === MAX_ATTEMPTS) {
          throw new Error('Jev request failed (network error); no successful review was recorded.', { cause: error });
        }
        await pause(backoff(attempt), signal);
        continue;
      }
      if (response.ok) {
        const parsed = responseSchema.safeParse(await boundedJson(response));
        if (!parsed.success) throw new Error('Jev returned an invalid response; review is incomplete.');
        for (const [id, question] of Object.entries(questions)) {
          const answer = parsed.data.answers[id];
          if (!answer || answer.type !== question.type) throw new Error(`Jev returned an incomplete or invalid decision for ${id}; review is incomplete.`);
          if (answer.type === 'noul') continue;
          const keys = Object.keys(question.criteria);
          if ((answer.type === 'choice' && !keys.includes(answer.choice))
            || (answer.type === 'score' && (answer.score > keys.length - 1 || keys.some(key => !answer.legend[key])))
            || keys.some(key => answer.probabilities[key] === undefined)
            || Object.keys(answer.probabilities).some(key => !keys.includes(key))
            || Math.abs(Object.values(answer.probabilities).reduce((a, b) => a + b, 0) - 1) > 0.02) {
            throw new Error(`Jev returned an incomplete or invalid decision for ${id}; review is incomplete.`);
          }
        }
        return parsed.data;
      }
      // Read only a known error code; never surface a remote body that may echo source.
      if (response.status === 400) {
        const body: unknown = await boundedJson(response).catch(() => null);
        const direct = z.object({ detail: z.object({ error_type: z.string() }) }).safeParse(body);
        // OpenRouter forwards TypeSafe's error body as a string inside its own error envelope.
        const relayed = z.object({ error: z.object({ message: z.string() }) }).safeParse(body);
        if ((direct.success && direct.data.detail.error_type === 'max_tokens_exceeded')
          || (relayed.success && /"error_type"\s*:\s*"max_tokens_exceeded"/.test(relayed.data.error.message))) {
          throw new Error('Jev context limit exceeded. Split the review into coherent slices that retain relevant contracts and callers.');
        }
      } else await response.body?.cancel();
      if (!RETRYABLE_STATUSES.includes(response.status) || attempt === MAX_ATTEMPTS) {
        throw new Error(`Jev request failed (HTTP ${response.status}); no successful review was recorded.`);
      }
      const retryAfter = response.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const requestedDelay = Number.isFinite(seconds) ? seconds * 1_000 : retryAfter ? Date.parse(retryAfter) - Date.now() : NaN;
      const delay = Number.isFinite(requestedDelay) ? Math.max(0, requestedDelay) : backoff(attempt);
      // Long Retry-After values must not be silently shortened.
      if (delay > 10_000) throw new Error('Jev requested a longer retry delay; try this review again later.');
      await pause(delay, signal);
    }
  }
}

function backoff(attempt: number): number {
  return 500 * 2 ** (attempt - 1) + Math.random() * 150;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((done, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); done(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
