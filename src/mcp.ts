import { verify, verificationInputSchema, verificationOutputSchema } from './verify.js';
import { McpServer, type ServerContext } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';
import { gitRoot } from './git-context.js';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings } from './jev.js';
import { applyPreviousEvaluation, estimateReview, isIncomplete, reviewAll } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, qualityEvaluationSchema } from './quality.js';
import { reportSchema } from './schema.js';
import { type DiscoveryScope, type Report, type TypedEvaluator } from './domain.js';
import { DEFAULT_MAX_REQUESTS, maxRequestsSchema, reviewScopeFields, reviewTimeoutSchema, VERIFY_TIMEOUT_MS } from './collection-options.js';
import { CONFIG_FILE, resolveSettings } from './project-config.js';
import { deadline } from './deadline.js';
import { ReviewProgress } from './progress.js';
import { releaseVersion } from './version.js';

const CACHE_LIMIT = 16;
const CACHE_TTL_MS = 300_000;

/** A bounded map whose entries expire. Insertion order is expiry order, so the first entry is the oldest. */
export class ExpiringCache<V> {
  private readonly entries = new Map<string, { expires: number; value: V }>();
  constructor(private readonly limit: number, private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): V | undefined {
    const entry = this.entries.get(key);
    if (entry && entry.expires > this.now()) return entry.value;
    this.entries.delete(key);
    return undefined;
  }

  /** Purges expired entries, then evicts the oldest live entry only when a new key would exceed the limit. */
  set(key: string, value: V): void {
    const now = this.now();
    for (const [existing, entry] of this.entries) if (entry.expires <= now) this.entries.delete(existing);
    if (!this.entries.delete(key) && this.entries.size >= this.limit) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { expires: now + this.ttlMs, value });
  }
}

type Flight<V, L> = { controller: AbortController; result: Promise<V>; waiting: number; listeners: Set<L>; events: ((listener: L) => void)[] };
type SharedTask<V, L> = (signal: AbortSignal, emit: (event: (listener: L) => void) => void) => Promise<V>;

/**
 * Work shared by key while it runs: a call whose key matches running work waits for it instead of starting it again.
 * The work reports progress as events, and a call that joins late first receives the events it missed. Each call stops
 * waiting as soon as its own signal aborts. The work is aborted only when no call is still waiting for it, and the next
 * call with that key then starts afresh.
 */
class SharedWork<V, L> {
  private readonly flights = new Map<string, Flight<V, L>>();

  /** Runs `task` for `key`, or waits for the run already in flight; `joined` is true when another call started it. */
  async run(key: string, signal: AbortSignal, listener: L | undefined, task: SharedTask<V, L>): Promise<{ value: V; joined: boolean }> {
    signal.throwIfAborted();
    const running = this.flights.get(key);
    const flight = running ?? this.start(key, task);
    flight.waiting++;
    if (listener) {
      for (const event of flight.events) event(listener);
      flight.listeners.add(listener);
    }
    let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => { stop = () => reject(signal.reason); });
    signal.addEventListener('abort', stop, { once: true });
    try {
      return { value: await Promise.race([flight.result, stopped]), joined: running !== undefined };
    } finally {
      signal.removeEventListener('abort', stop);
      if (listener) flight.listeners.delete(listener);
      if (--flight.waiting === 0 && this.flights.get(key) === flight) {
        this.flights.delete(key);
        flight.controller.abort(signal.reason);
      }
    }
  }

  private start(key: string, task: SharedTask<V, L>): Flight<V, L> {
    const controller = new AbortController();
    const listeners = new Set<L>();
    const events: ((listener: L) => void)[] = [];
    const result = task(controller.signal, event => { events.push(event); for (const listener of listeners) event(listener); })
      .finally(() => { if (this.flights.get(key) === flight) this.flights.delete(key); });
    // Work that every call stopped waiting for is aborted with no one left to observe its rejection.
    result.catch(() => {});
    const flight: Flight<V, L> = { controller, result, waiting: 0, listeners, events };
    this.flights.set(key, flight);
    return flight;
  }
}

/** A tool result that carries `output` both as structured content and as JSON text. */
function toolResult<T extends Record<string, unknown>>(output: T) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(output) }], structuredContent: output };
}

/**
 * Review progress for a request that carries a progress token, or undefined without one. Notifications go out in
 * order, and a failed notification never fails the review. `sent` settles once every notification so far was written.
 */
function progressFor(ctx: ServerContext) {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  let sent = Promise.resolve();
  const progress = new ReviewProgress(update => {
    sent = sent.then(() => ctx.mcpReq.notify({ method: 'notifications/progress', params: { progressToken, ...update } })).catch(() => {});
  });
  return { review: progress, sent: () => sent };
}

export function createServer(repo?: string, evaluatorFactory?: (signal: AbortSignal) => TypedEvaluator) {
  const server = new McpServer({ name: 'tracecheck', version: releaseVersion });
  const cache = new ExpiringCache<Report>(CACHE_LIMIT, CACHE_TTL_MS);
  const previewScopes = new ExpiringCache<DiscoveryScope>(CACHE_LIMIT, CACHE_TTL_MS);
  const reviews = new SharedWork<Report, ReviewProgress>();
  const scope = { repo: z.string().min(1).optional().describe('Path to the repository or any directory in it. Required unless the server was launched with --repo; a bound server rejects a path in another repository.'),
    base: reviewScopeFields.base.optional().describe('Git ref to review changes against, such as origin/main. The working tree is compared against the merge base of this ref and HEAD, so commits made only on a branch that has moved on are left out. Defaults to HEAD.'),
    includeUntracked: reviewScopeFields.includeUntracked.optional().describe('Include untracked files. Defaults to false.'),
    task: reviewScopeFields.task.optional().describe(`Current task or requirements. Defaults to the repository's ${CONFIG_FILE}, which the output then labels as repository-supplied.`),
    repositoryContext: reviewScopeFields.repositoryContext.optional().describe(`Repository facts for reviewers. Defaults to the repository's ${CONFIG_FILE}, which the output then labels as repository-supplied.`),
    collection: reviewScopeFields.collection.optional().describe(`Bounded local collection settings; each key overrides ${CONFIG_FILE}. Matching settings are required when reviewing a preview snapshot.`) };
  /**
   * The repository path a call works on. A bound server accepts a `repo` argument that names any directory in its Git
   * working tree, as the CLI does, and rejects every other path. A path Git cannot open is named as given.
   */
  const target = async (requested: string | undefined, signal: AbortSignal) => {
    if (!repo) {
      if (!requested) throw new Error('Supply repo or launch the server with --repo.');
      return requested;
    }
    if (requested === undefined) return repo;
    if (await gitRoot(requested, { signal }) !== await gitRoot(repo, { signal })) throw new Error('This server is bound to a different repository.');
    return requested;
  };
  server.registerTool('tracecheck_verify', {
    description: 'Verify one agent-discovered defect hypothesis against agent-selected source, contract, and counterevidence in any language. Validates exact target quotes; optional repo checks every excerpt against local files before and after inference. Returns support, impact, uncertainty, and a missing-evidence category. Does not discover concerns, execute code, or prove a fix.',
    inputSchema: verificationInputSchema, outputSchema: verificationOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal, deadline(VERIFY_TIMEOUT_MS, `Verification timed out after ${VERIFY_TIMEOUT_MS} ms.`)]);
    const selected = repo || args.repo ? await target(args.repo, signal) : undefined;
    const output = await verify({ ...args, repo: selected }, evaluatorFactory?.(signal) ?? jevFromEnv(signal), signal);
    return toolResult(output);
  });
  server.registerTool('tracecheck_assess', {
    description: `Review caller-supplied task, diff, files, and repository context across 19 independent quality dimensions with Jev. Language-agnostic; no filesystem reads. Optional previousEvaluation is compared locally. Returns scores, confidence, prioritized concerns, and changes. Times out after ${ASSESS_TIMEOUT_MS / 1000} seconds.`,
    inputSchema: qualityInputSchema, outputSchema: qualityEvaluationSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const signal = AbortSignal.any([ctx.mcpReq.signal, deadline(ASSESS_TIMEOUT_MS, `Assessment timed out after ${ASSESS_TIMEOUT_MS} ms.`)]);
    const output = await assess(args, evaluatorFactory?.(signal) ?? jevFromEnv(signal), signal);
    return toolResult(output);
  });
  server.registerTool('tracecheck_preview', {
    description: 'Collect bounded evidence for all change packets and source checks. Local only; no Jev request. Returns a snapshot token required by tracecheck_review and the number of provider requests that review would make.',
    inputSchema: z.object(scope),
    outputSchema: z.object({
      snapshot: z.string(),
      base: z.string().describe('Commit the working tree is compared against: the merge base of baseRef and HEAD.'),
      baseRef: z.string().describe('The requested base ref.'),
      packets: z.array(z.object({ id: z.string(), changedPaths: z.array(z.string()) })),
      files: z.array(z.object({ path: z.string(), previousPath: z.string().optional(), role: z.string(), characters: z.number() })),
      candidates: z.number(), limitations: z.array(z.string()),
      notes: z.array(z.string()).describe(`Caveats that never affect the status, including any task or repository context taken from the repository's ${CONFIG_FILE}.`),
      estimate: z.object({ requests: z.number(), inputBytes: z.number() })
        .describe('Provider requests tracecheck_review would make and their serialized evidence and question bytes.'),
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (args, ctx) => {
    const settings = await resolveSettings(await target(args.repo, ctx.mcpReq.signal), args, ctx.mcpReq.signal);
    const plan = await collect({ repo: settings.root, ...settings.request, signal: ctx.mcpReq.signal });
    if (!plan.discovery) throw new Error('Collection did not produce a discovery scope. Run tracecheck_preview again.');
    previewScopes.set(plan.snapshot, plan.discovery);
    const output = { snapshot: plan.snapshot, base: plan.base, baseRef: plan.baseRef ?? 'HEAD', packets: plan.packets.map(packet => ({ id: packet.id, changedPaths: packet.changedPaths })),
      files: plan.sources.map(source => ({ path: source.path, ...(source.previousPath ? { previousPath: source.previousPath } : {}), role: source.role, characters: source.content.length + (source.before?.length ?? 0) })),
      candidates: plan.candidates.length, limitations: plan.limitations, notes: [...plan.notes, ...settings.settingsFileNotes], estimate: estimateReview(plan) };
    return toolResult(output);
  });
  server.registerTool('tracecheck_review', {
    description: 'Review all previewed change packets with bounded evidence and individual packet quality assessments using Jev. Sends collected source and base versions to the configured provider: TypeSafe, OpenRouter, OpenJEV, or the endpoint in TYPESAFE_BASE_URL. Optional previousEvaluation is compared only for a single-packet quality result. Never edits or executes code.',
    inputSchema: z.object({ ...scope, reviewTimeoutMs: reviewTimeoutSchema.optional().describe(`Maximum review duration in milliseconds. Defaults to ${CONFIG_FILE}, then 300000.`),
      maxRequests: maxRequestsSchema.optional().describe(`Most provider requests this review may make; a larger review is refused before any request. Defaults to ${CONFIG_FILE}, which may only lower it, then ${DEFAULT_MAX_REQUESTS}. Compare with the preview estimate.`),
      previousEvaluation: previousEvaluationSchema.optional(), snapshot: z.string().length(64).describe('Snapshot returned by tracecheck_preview. A changed snapshot is rejected.') }),
    outputSchema: z.object({
      cached: z.boolean().describe('True when this call made no provider request: the report came from the cache, or from an identical review that another call had in flight.'),
      report: reportSchema,
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async (args, ctx) => {
    const progress = progressFor(ctx);
    const effective = await resolveSettings(await target(args.repo, ctx.mcpReq.signal), args, ctx.mcpReq.signal);
    const { reviewTimeoutMs, maxRequests, request: collectionRequest } = effective;
    const signal = AbortSignal.any([ctx.mcpReq.signal,
      deadline(reviewTimeoutMs, `Review timed out after ${reviewTimeoutMs} ms. Raise reviewTimeoutMs to allow more time.`)]);
    const discovery = previewScopes.get(args.snapshot);
    if (!discovery) throw new Error('Preview snapshot is unknown or expired. Run tracecheck_preview again.');
    const plan = await collect({ ...collectionRequest, repo: effective.root, discovery, signal, onPhase: progress?.review.phase });
    if (plan.snapshot !== args.snapshot) throw new Error('Repository context changed since preview. Run tracecheck_preview again.');
    const settings = jevSettings(process.env, effective.provider);
    const key = `${plan.root}:${plan.snapshot}:${settings.baseUrl}:${settings.model}`;
    // A hit needs no second collection: the collection above already matched the preview snapshot.
    let report = cache.get(key);
    let cached = report !== undefined;
    if (!report) {
      // Identical calls share one review in flight, which stops only when every call waiting for it has been cancelled
      // or timed out. The request budget is part of the key, so no call is refused over another call's budget.
      const shared = await reviews.run(`${key}:${maxRequests}`, signal, progress?.review, async (reviewSignal, emit) => {
        const fresh = await reviewAll(plan, evaluatorFactory?.(reviewSignal) ?? new Jev({ ...settings, signal: reviewSignal }), { signal: reviewSignal,
          concurrency: settings.concurrency, maxRequests, onProgress: (completed, total) => emit(each => each.requests(completed, total)) });
        reviewSignal.throwIfAborted();
        emit(each => each.checking());
        const current = await collect({ ...collectionRequest, repo: plan.root, discovery, signal: reviewSignal });
        if (current.snapshot !== plan.snapshot) throw new Error('Repository changed during review. Preview and review again.');
        // A retry must reach the provider again rather than replay a review that a failed request left incomplete.
        if (!isIncomplete(fresh)) cache.set(key, fresh);
        emit(each => each.finished());
        return fresh;
      });
      report = shared.value;
      cached = shared.joined;
    }
    const compared = structuredClone(report);
    applyPreviousEvaluation(compared, args.previousEvaluation);
    compared.notes.push(...effective.settingsFileNotes);
    const output = { cached, report: compared };
    await progress?.sent();
    return toolResult(output);
  });
  return server;
}

export async function serve(repo?: string) {
  const server = createServer(repo);
  await server.connect(new StdioServerTransport());
  const close = async () => { await server.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}
