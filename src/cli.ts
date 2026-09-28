#!/usr/bin/env node
import { verify, verificationInputSchema } from './verify.js';
import { parseArgs } from 'node:util';
import { constants } from 'node:fs';
import { access, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { collect } from './collector.js';
import { Jev, jevFromEnv, jevSettings, type JevSettings } from './jev.js';
import { deadline } from './deadline.js';
import { estimateReview, markStale, reviewAll, render } from './review.js';
import { ASSESS_TIMEOUT_MS, assess, previousEvaluationSchema, qualityInputSchema, renderQuality, type PreviousEvaluation } from './quality.js';
import { compare } from './history.js';
import { reportSchema } from './schema.js';
import { toSarif } from './sarif.js';
import { collectionOptionsSchema, DEFAULT_MAX_REQUESTS, reviewTimeoutSchema, VERIFY_TIMEOUT_MS, type CollectionOptions } from './collection-options.js';
import { CONFIG_FILE, resolveSettings } from './project-config.js';
import { ReviewProgress } from './progress.js';
import { terminalLines, terminalText } from './terminal.js';
import type { Report } from './domain.js';

/** Exit codes for review and verify statuses, as the help text documents them. */
const EXIT_CODES = { needs_attention: 1, inconclusive: 3, no_findings: 0 } as const satisfies Record<Report['status'], number>;
/** A review whose evidence changed while it ran; the report is printed, marked stale. */
const STALE_EXIT_CODE = 4;
/** The conventional exit code for a command stopped by SIGINT: 128 plus the signal number 2. */
const INTERRUPTED_EXIT_CODE = 130;
/** Aborted by the first SIGINT, which stops the command's work; a second SIGINT ends the process at once. */
const interrupt = new AbortController();

/** Each command's usage, printed by --help and with an argument error. Continuation lines align under the options. */
const USAGE = {
  preview: `tracecheck preview [--repo PATH] [--base REF] [--[no-]include-untracked] [--task TEXT]
                     [--context TEXT] [collection limits] [--max-requests N] [--json]`,
  review: `tracecheck review  [--repo PATH] [--base REF] [--[no-]include-untracked] [--task TEXT]
                     [--context TEXT] [collection limits] [--review-timeout-ms N]
                     [--max-requests N] [--previous FILE] [--json] [--out FILE]
                     [--sarif FILE] [--quiet]`,
  verify: 'tracecheck verify  --input FILE [--repo PATH] [--out FILE]',
  assess: 'tracecheck assess  --input FILE [--previous FILE] [--json] [--out FILE] [--fail-on-priorities]',
  compare: 'tracecheck compare --previous FILE --current FILE',
  mcp: 'tracecheck mcp     [--repo PATH]',
} as const;
type Command = keyof typeof USAGE;
const isCommand = (value: string): value is Command => Object.hasOwn(USAGE, value);

function positiveSafeInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive safe integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive safe integer.`);
  return parsed;
}
/** A millisecond flag; errors name the flag and its limit. */
function timeoutFlag(value: string | undefined, flag: string): number | undefined {
  return validate(reviewTimeoutSchema.optional(), positiveSafeInteger(value, flag), `${flag} is out of range`);
}
function collectionOptions(values: {
  'index-max-files'?: string;
  'index-max-bytes'?: string;
  'index-timeout-ms'?: string;
  'collection-timeout-ms'?: string;
}): CollectionOptions {
  return collectionOptionsSchema.parse({
    maxIndexFiles: positiveSafeInteger(values['index-max-files'], '--index-max-files'),
    maxIndexBytes: positiveSafeInteger(values['index-max-bytes'], '--index-max-bytes'),
    indexTimeoutMs: timeoutFlag(values['index-timeout-ms'], '--index-timeout-ms'),
    collectionTimeoutMs: timeoutFlag(values['collection-timeout-ms'], '--collection-timeout-ms'),
  });
}

/** Saves `value` as JSON that only the owner can read, creating the parent directory. */
async function writeJson(file: string, value: unknown): Promise<void> {
  const destination = resolve(file);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

const FILE_PROBLEMS: Record<string, string> = {
  ENOENT: 'no such file or directory', EISDIR: 'it is a directory', ENOTDIR: 'a parent path is not a directory',
  EACCES: 'permission denied', EPERM: 'permission denied', EROFS: 'read-only file system', ENOSPC: 'no space left on device',
};
/** Why a file operation failed, without the resolved absolute path that Node puts in its messages. */
function fileProblem(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return (code && FILE_PROBLEMS[code]) || code || (error instanceof Error ? error.message : 'unexpected error');
}

/**
 * Fails unless `file`, the destination of `flag`, can be written, so a paid-for result is not lost to a bad path.
 * A missing parent directory is accepted when its nearest existing ancestor is a writable directory; writeJson creates it.
 */
async function checkWritable(flag: string, file: string | undefined): Promise<void> {
  if (file === undefined) return;
  const fail = (problem: string) => new Error(`${flag} ${file} cannot be written: ${problem}.`);
  const existing = async (path: string) => {
    try { return await stat(path); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw fail(fileProblem(error));
    }
  };
  let path = resolve(file);
  const target = await existing(path);
  if (target?.isDirectory()) throw fail('it is a directory');
  if (!target) {
    // The file system root always exists, so the walk ends.
    for (path = dirname(path); ; path = dirname(path)) {
      const ancestor = await existing(path);
      if (!ancestor) continue;
      if (!ancestor.isDirectory()) throw fail('a parent path is not a directory');
      break;
    }
  }
  try { await access(path, constants.W_OK); } catch (error) { throw fail(fileProblem(error)); }
}

/** Writes each requested output file after the result is printed; a failure names the file and exits 2. */
async function writeOutputs(outputs: Array<[flag: string, file: string | undefined, value: () => unknown]>): Promise<void> {
  const failures: string[] = [];
  for (const [flag, file, value] of outputs) {
    if (file === undefined) continue;
    try { await writeJson(file, value()); } catch (error) { failures.push(`${flag} ${file} could not be written: ${fileProblem(error)}.`); }
  }
  if (failures.length) throw new Error(`${failures.join('\n')}\nThe result printed above is complete.`);
}

/** Reads the JSON file that `flag` names. Errors name the file as the user typed it. */
async function readJsonFile(flag: string, file: string): Promise<unknown> {
  let text: string;
  try { text = await readFile(file, 'utf8'); } catch (error) { throw new Error(`${flag} ${file} cannot be read: ${fileProblem(error)}.`); }
  try { return JSON.parse(text); } catch (error) {
    throw new Error(`${flag} ${file} is not valid JSON: ${terminalText(error instanceof Error ? error.message : String(error))}`);
  }
}

const MAX_ISSUES = 10;
/** One indented line per validation issue, prefixed by its field when it has one, such as `evidence[0].startLine: Invalid input`. */
function issueLines(error: z.ZodError): string {
  const field = (path: PropertyKey[]) => path.map((key, index) => typeof key === 'number' ? `[${key}]` : `${index ? '.' : ''}${String(key)}`).join('');
  const lines = error.issues.slice(0, MAX_ISSUES).map(issue => `  ${terminalText(`${issue.path.length ? `${field(issue.path)}: ` : ''}${issue.message}`)}`);
  if (error.issues.length > MAX_ISSUES) lines.push(`  and ${error.issues.length - MAX_ISSUES} more.`);
  return lines.join('\n');
}

/** Parses `value` with `schema`; `problem`, such as "--input x.json is not valid", introduces the list of issues. */
function validate<S extends z.ZodType>(schema: S, value: unknown, problem: string): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new Error(`${problem}:\n${issueLines(result.error)}`);
  return result.data;
}

/** Reads the quality evaluation to compare with from a saved review report or an assess evaluation. */
async function readPrevious(file: string): Promise<PreviousEvaluation> {
  const value = await readJsonFile('--previous', file);
  const report = reportSchema.safeParse(value);
  if (report.success) {
    if (report.data.quality) return report.data.quality;
    throw new Error(report.data.packetQualities?.length
      ? `--previous ${file} is a multi-packet review report; only a single-packet report has one quality evaluation to compare.`
      : `--previous ${file} is a review report without a quality evaluation to compare.`);
  }
  const evaluation = previousEvaluationSchema.safeParse(value);
  if (evaluation.success) return evaluation.data;
  throw new Error(`--previous ${file} is neither a report saved by review --out nor an evaluation saved by assess --out.`);
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, allowNegative: true, options: {
    repo: { type: 'string' }, base: { type: 'string' },
    'include-untracked': { type: 'boolean' }, json: { type: 'boolean', default: false },
    out: { type: 'string' }, current: { type: 'string' }, previous: { type: 'string' }, help: { type: 'boolean', short: 'h' },
    input: { type: 'string' }, task: { type: 'string' }, context: { type: 'string' },
    'index-max-files': { type: 'string' }, 'index-max-bytes': { type: 'string' },
    'index-timeout-ms': { type: 'string' }, 'collection-timeout-ms': { type: 'string' },
    'review-timeout-ms': { type: 'string' }, 'max-requests': { type: 'string' },
    sarif: { type: 'string' }, 'fail-on-priorities': { type: 'boolean', default: false },
    quiet: { type: 'boolean', short: 'q', default: false },
  } });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Tracecheck: evidence-backed review powered by Jev

Usage:
${Object.values(USAGE).map(usage => `  ${usage}`).join('\n')}

Options:
  --repo PATH                 Git repository to collect; defaults to the current directory. verify
                              matches excerpts against it; mcp uses it when a call names none.
  --base REF                  Git ref to review changes against (default: HEAD). The working
                              tree is compared against the merge base of REF and HEAD.
  --include-untracked         Include supported, non-ignored untracked files.
  --no-include-untracked      Exclude untracked files (the default).
  --task TEXT                 Requested behavior or acceptance criteria.
  --context TEXT              Repository facts, contracts, or observed test results.
  --review-timeout-ms N       Review deadline (default: 300000).
  --max-requests N            Most provider requests a review may make (default: ${DEFAULT_MAX_REQUESTS}).
                              A larger review is refused before any request; preview shows
                              the estimate.
  --input FILE                verify: evidence JSON. assess: context JSON.
  --previous FILE             review and assess: a report saved by review --out or an evaluation
                              saved by assess --out; its quality evaluation is compared with this
                              run. compare: the earlier review report.
  --current FILE              compare: the later review report.
  --json                      Print JSON instead of Markdown (preview, review, assess).
  --out FILE                  Save the review report, verification result, or evaluation as JSON.
  --sarif FILE                review: also write supported findings as SARIF 2.1.0.
  -q, --quiet                 review: do not print progress lines to stderr. Progress never goes
                              to stdout, so the report is the same either way.
  --fail-on-priorities        assess: exit 1 when the evaluation lists actionable quality priorities.
  -h, --help                  Show this help.

Collection limits (preview and review): --index-max-files N, --index-max-bytes N,
--index-timeout-ms N (default 20000), --collection-timeout-ms N (default 120000).
All N values are positive safe integers.

Commands take no positional arguments besides the command name. --out and --sarif paths are
checked before any collection or provider request, and the result is printed before they are
written, so a failed write still leaves the printed result and exits 2.

Exit codes:
  0  Success. review and verify found nothing that needs attention; assess never fails on
     its results unless --fail-on-priorities is set.
  1  review: supported findings or quality priorities. verify: the hypothesis is supported.
     assess --fail-on-priorities: actionable quality priorities.
  2  Execution or input error.
  3  review or verify is inconclusive.
  4  review: the reviewed files changed while the review ran. The report is still printed
     and saved, marked stale; run review again.
  130  Interrupted with Ctrl-C (SIGINT).

Preview and compare are local. Review, verify, and assess send bounded evidence to Jev and
require JEV_API_KEY or TYPESAFE_API_KEY (TypeSafe), OPENJEV_API_KEY (OpenJEV), or OPENROUTER_API_KEY
(OpenRouter); they check for a key after reading their input files and before collecting from the repository.
Optional TYPESAFE_BASE_URL overrides the endpoint base URL. Optional JEV_PROVIDER selects the provider
explicitly (openjev, typesafe, or openrouter). Optional JEV_MODEL selects the model
(default: jev-latest for TypeSafe/OpenRouter, openjev for OpenJEV). Optional JEV_TIMEOUT_MS limits each Jev request (default: 45000).
Optional JEV_CONCURRENCY sets how many review requests run at once (default: 4, at most 16).
Each change packet receives an individual bounded quality assessment. Automatic
source-anchored checks cover three JS/TS patterns; no code or tests are executed.
Packet evidence is bounded and does not establish repository-wide semantic completeness.
Use --task and --context to supply requirements and repository facts.

Preview and review read optional defaults from ${CONFIG_FILE} at the repository root: task,
repositoryContext, collection, reviewTimeoutMs, model, requestTimeoutMs, requestConcurrency,
and maxRequests. Anyone who can commit to the repository controls the file, so it may only
lower limits: a timeout, requestConcurrency, or maxRequests above its default, base other
than HEAD, or includeUntracked true is an error. Preview and review print any task or
context the file supplied. Flags override the file, and JEV_MODEL, JEV_TIMEOUT_MS, and
JEV_CONCURRENCY override its model, requestTimeoutMs, and requestConcurrency. The file
cannot hold credentials or the endpoint.`);
    return;
  }
  if (!isCommand(command)) throw new Error(`Unknown command: ${command}`);
  const extra = positionals.slice(1);
  if (extra.length) {
    const scope = command === 'preview' || command === 'review' ? ` It has no path filter; it covers every change in the repository that --repo names.` : '';
    throw new Error(`Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}. tracecheck ${command} takes no positional arguments.${scope}\nUsage:\n  ${USAGE[command]}`);
  }
  if (command === 'mcp') {
    const { serve } = await import('./mcp.js');
    await serve(values.repo ? resolve(values.repo) : undefined);
    return;
  }
  if (command === 'compare') {
    if (!values.previous || !values.current) throw new Error('compare requires --previous old.json --current current.json');
    const previous = validate(reportSchema, await readJsonFile('--previous', values.previous), `--previous ${values.previous} is not a report saved by review --out`);
    const current = validate(reportSchema, await readJsonFile('--current', values.current), `--current ${values.current} is not a report saved by review --out`);
    console.log(JSON.stringify(compare(previous, current), null, 2));
    return;
  }
  process.once('SIGINT', () => interrupt.abort(new Error('Interrupted.')));
  if (command === 'verify') {
    if (!values.input) throw new Error('verify requires --input evidence.json');
    await checkWritable('--out', values.out);
    const raw = await readJsonFile('--input', values.input);
    const input = validate(verificationInputSchema, values.repo && typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw, repo: values.repo } : raw,
      `--input ${values.input} is not valid verify evidence`);
    const signal = AbortSignal.any([interrupt.signal, deadline(VERIFY_TIMEOUT_MS, `Verification timed out after ${VERIFY_TIMEOUT_MS} ms.`)]);
    const output = await verify(input, jevFromEnv(signal), signal);
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = EXIT_CODES[output.report.status];
    await writeOutputs([['--out', values.out, () => output]]);
    return;
  }
  if (command === 'assess') {
    if (!values.input) throw new Error('assess requires --input context.json');
    await checkWritable('--out', values.out);
    const input = validate(qualityInputSchema, await readJsonFile('--input', values.input), `--input ${values.input} is not valid assess context`);
    if (values.previous) input.previousEvaluation = await readPrevious(values.previous);
    const signal = AbortSignal.any([interrupt.signal, deadline(ASSESS_TIMEOUT_MS, `Assessment timed out after ${ASSESS_TIMEOUT_MS} ms.`)]);
    const evaluation = await assess(input, jevFromEnv(signal), signal);
    console.log(values.json ? JSON.stringify(evaluation, null, 2) : renderQuality(evaluation));
    if (values['fail-on-priorities'] && evaluation.priorities.length) process.exitCode = 1;
    await writeOutputs([['--out', values.out, () => evaluation]]);
    return;
  }
  if (command === 'review') {
    await checkWritable('--out', values.out);
    await checkWritable('--sarif', values.sarif);
    if (values.out !== undefined && values.sarif !== undefined && resolve(values.out) === resolve(values.sarif)) throw new Error('--out and --sarif name the same file; name two different files.');
  }
  const settings = await resolveSettings(values.repo ?? '.', { base: values.base, includeUntracked: values['include-untracked'],
    task: values.task, repositoryContext: values.context, collection: collectionOptions(values),
    reviewTimeoutMs: timeoutFlag(values['review-timeout-ms'], '--review-timeout-ms'),
    maxRequests: positiveSafeInteger(values['max-requests'], '--max-requests') }, interrupt.signal);
  const { reviewTimeoutMs, maxRequests, settingsFileNotes: notes, request: collectionRequest } = settings;
  // Collection can take minutes, so review reads --previous and checks the provider key and endpoint first.
  let live: { previous?: PreviousEvaluation; provider: JevSettings; jev: Jev } | undefined;
  if (command === 'review') {
    const previous = values.previous ? await readPrevious(values.previous) : undefined;
    const provider = jevSettings(process.env, settings.provider);
    live = { previous, provider, jev: new Jev({ ...provider, signal: interrupt.signal }) };
  }
  const progress = live && !values.quiet ? new ReviewProgress(update => console.error(`Tracecheck progress: ${terminalText(update.message)}`)) : undefined;
  const plan = await collect({ repo: settings.root, ...collectionRequest, signal: interrupt.signal, onPhase: progress?.phase });
  if (!live) { // preview: only review sets live
    const packets = plan.packets.map(packet => `${packet.id}: ${packet.changedPaths.map(terminalText).join(', ')}`).join('\n');
    const estimate = estimateReview(plan);
    const refused = estimate.requests > maxRequests ? `; review will be refused unless --max-requests is at least ${estimate.requests}` : '';
    console.log(values.json ? JSON.stringify({ ...plan, notes: [...plan.notes, ...notes], estimate }, null, 2) : `Tracecheck preview (local only)\n${collectionRequest.projectConfig ? `Settings: ${CONFIG_FILE}\n` : ''}Snapshot: ${plan.snapshot}\nBase: ${plan.base.slice(0, 12)} (from ${terminalText(plan.baseRef ?? 'HEAD')})\n${plan.packets.length} change packets · ${plan.sources.length} files · ${plan.candidates.length} candidates\nReview estimate: ${estimate.requests} provider request(s) carrying ${estimate.inputBytes} bytes of evidence and questions (budget: ${maxRequests}${refused}). Empty-evidence packets are not sent.\n${packets}\n${plan.sources.map(source => `${source.role}: ${terminalText(source.path)}${source.previousPath ? ` (renamed from ${terminalText(source.previousPath)})` : ''}`).join('\n')}\n${[...plan.notes, ...notes].map(item => `Note: ${terminalText(item)}`).join('\n')}\n${plan.limitations.map(item => `Coverage gap: ${terminalText(item)}`).join('\n')}`);
    return;
  }
  const reviewSignal = AbortSignal.any([interrupt.signal,
    deadline(reviewTimeoutMs, `Review timed out after ${reviewTimeoutMs} ms. Raise --review-timeout-ms to allow more time.`)]);
  const report = await reviewAll(plan, live.jev,
    { signal: reviewSignal, concurrency: live.provider.concurrency, maxRequests, previousEvaluation: live.previous, onProgress: progress?.requests });
  reviewSignal.throwIfAborted();
  report.notes.push(...notes);
  progress?.checking();
  const current = await collect({ repo: plan.root, ...collectionRequest, discovery: plan.discovery, signal: reviewSignal });
  // The provider requests are already paid for, so a changed repository marks the report stale instead of discarding it.
  const stale = current.snapshot !== plan.snapshot;
  if (stale) markStale(report);
  progress?.finished();
  if (stale) console.error('Tracecheck: the repository changed during the review, so the report is marked stale. Run review again.');
  console.log(values.json ? JSON.stringify(report, null, 2) : render(report));
  process.exitCode = stale ? STALE_EXIT_CODE : EXIT_CODES[report.status];
  await writeOutputs([['--out', values.out, () => report], ['--sarif', values.sarif, () => toSarif(report)]]);
}

main().catch(error => {
  if (interrupt.signal.aborted) {
    console.error('Tracecheck: interrupted.');
    process.exitCode = INTERRUPTED_EXIT_CODE;
    return;
  }
  // A schema parse outside validate() still prints one line per issue, never the raw issue array.
  const message = error instanceof z.ZodError ? `Invalid input:\n${issueLines(error)}` : error instanceof Error ? error.message : 'Unexpected failure';
  console.error(`Tracecheck: ${terminalLines(message)}`);
  process.exitCode = 2;
});
