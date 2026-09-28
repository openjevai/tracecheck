// Calibrates Tracecheck's decision gates against a live Jev model.
//
//   npm run calibrate -- run                     Builds and collects every labeled case offline; no key or request.
//   npm run calibrate -- run --live              Reviews every case with the configured provider and records raw answers.
//   npm run calibrate -- replay <run directory>  Recomputes every table from the raw answers alone.
//
// `run --live` writes .tracecheck/calibration/<timestamp>/raw.jsonl and then replays it. Pass --out with an existing run
// directory to resume it: reviews that already completed are skipped, and earlier requests count toward --max-requests.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { collect } from '../src/collector.js';
import type { Candidate, ReviewPlan, TypedAnswer, TypedEvaluator } from '../src/domain.js';
import { Jev, jevSettings } from '../src/jev.js';
import { dimensionKeys } from '../src/quality/dimensions.js';
import { QUALITY_GATES, SOURCE_GATES } from '../src/policy.js';
import { estimateReview, isIncomplete, reviewAll } from '../src/review.js';
import { cases, expectedChecks, variantNames, type CalibrationCase, type CheckLabel, type Family, type QualityLabels, type Split, type VariantName } from './calibration/cases.js';

/** The gates in src/policy.ts; replay reports them as the baseline. */
const CURRENT = { probability: SOURCE_GATES.probability, confidence: SOURCE_GATES.confidence, ...QUALITY_GATES };
const INPUT_DOLLARS_PER_MILLION = 0.042;
const REVIEW_TIMEOUT_MS = 300_000;
const splits: readonly Split[] = ['development', 'holdout'];

type ChoiceAnswer = Extract<TypedAnswer, { type: 'choice' }>;
type Context = { runId: string; caseId: string; variant: VariantName; repeat: number };
type CaseRow = {
  type: 'case'; caseId: string; family: Family; split: Split; language: 'typescript' | 'javascript'; variant: VariantName;
  snapshot: string; sources: Array<{ path: string; role: string }>; missingFiles: string[]; limitations: string[];
  candidates: Array<{ id: string; check: string; path: string; symbol: string; range: { start: number; end: number }; expected: CheckLabel }>;
  quality: QualityLabels; plannedRequests: number;
};
type ResponseRow = Context & { type: 'response'; candidateIds: string[]; questionCount: number; model: string; usage: { input_tokens: number; output_tokens: number }; answers: Record<string, TypedAnswer> };
type ReportRow = Context & {
  type: 'report'; status: string; models: string[]; incomplete: boolean; limitations: string[];
  usage: { inputTokens: number; outputTokens: number; requests: number; elapsedMs: number };
  decisions: Array<{ id: string; check: string; status: string; confidence: number; probability: number }>;
  quality?: { metrics: Record<string, { status: string; score?: number; weakness?: string; actionable?: boolean }>; priorities: string[] };
};
type Row = CaseRow | ResponseRow | ReportRow
  | (Context & { type: 'attempt'; status: number | null })
  | (Context & { type: 'error'; message: string })
  | { type: 'run'; runId: string; startedAt: string; revision: string; provider: string; model: string; repeats: number; maxRequests: number; concurrency: number; cases: number; node: string }
  | { type: 'end'; runId: string; finishedAt: string; attempts: number; stoppedAtCap: boolean };

type Prepared = { item: CalibrationCase; variant: VariantName; plan: ReviewPlan; row: CaseRow; problems: string[] };

function wholeNumber(value: string | undefined, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive whole number.`);
  return number;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const name = key(item);
    const group = groups.get(name);
    if (group) group.push(item);
    else groups.set(name, [item]);
  }
  return groups;
}

async function readRows(path: string): Promise<Row[]> {
  const text = await readFile(path, 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return ''; throw error; });
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line) as Row);
}

/** Builds a disposable repository for one variant, collects it with the real collector, and checks its labels. */
async function prepare(item: CalibrationCase, variant: VariantName): Promise<Prepared> {
  const root = await mkdtemp(join(tmpdir(), 'tracecheck-calibration-'));
  const git = (...gitArgs: string[]) => execFileSync('git', ['-C', root, ...gitArgs], { stdio: 'pipe' });
  const write = async (files: Record<string, string>) => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
  };
  try {
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Tracecheck calibration');
    git('config', 'user.email', 'calibration@example.invalid');
    git('config', 'core.hooksPath', '/dev/null');
    await write(item.base);
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'Baseline');
    await write(item.variants[variant]);
    const plan = await collect({ repo: root, task: item.task, includeUntracked: true });
    const expected = expectedChecks(item, variant);
    const problems: string[] = [];
    if (plan.packets.length !== 1) problems.push(`expected one packet, collected ${plan.packets.length}`);
    const checks = new Set(plan.candidates.map(candidate => candidate.check));
    for (const check of checks) if (!(check in expected)) problems.push(`unlabeled ${check} candidate`);
    for (const check of Object.keys(expected)) if (!checks.has(check)) problems.push(`no ${check} candidate`);
    const files = Object.keys({ ...item.base, ...item.variants[variant] });
    const row: CaseRow = {
      type: 'case', caseId: item.id, family: item.family, split: item.split, variant,
      language: files.some(path => path.endsWith('.js')) ? 'javascript' : 'typescript',
      snapshot: plan.snapshot, sources: plan.sources.map(source => ({ path: source.path, role: source.role })),
      missingFiles: files.filter(path => !plan.sources.some(source => source.path === path)), limitations: plan.limitations,
      candidates: plan.candidates.map(candidate => ({
        id: candidate.id, check: candidate.check, path: candidate.path, symbol: candidate.symbol,
        range: candidate.range, expected: expected[candidate.check as keyof typeof expected]!
      })),
      quality: item.quality, plannedRequests: estimateReview(plan).requests,
    };
    return { item, variant, plan, row, problems };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function checkLabels(item: CalibrationCase): string[] {
  const { relevant, irrelevant, lowerOnDefect } = item.quality;
  return [
    ...[...relevant, ...irrelevant].filter(key => !dimensionKeys.includes(key)).map(key => `${item.id}: unknown dimension ${key}`),
    ...relevant.filter(key => irrelevant.includes(key)).map(key => `${item.id}: ${key} is labeled both relevant and irrelevant`),
    ...lowerOnDefect.filter(key => !relevant.includes(key)).map(key => `${item.id}: lowerOnDefect ${key} is not labeled relevant`),
  ];
}

async function run(runArgs: string[]): Promise<void> {
  const { values } = parseArgs({
    args: runArgs, options: {
      live: { type: 'boolean' }, repeats: { type: 'string', default: '3' }, 'max-requests': { type: 'string', default: '400' },
      concurrency: { type: 'string', default: '4' }, cases: { type: 'string' }, out: { type: 'string' },
    }
  });
  const repeats = wholeNumber(values.repeats, '--repeats');
  const maxRequests = wholeNumber(values['max-requests'], '--max-requests');
  const concurrency = wholeNumber(values.concurrency, '--concurrency');
  const wanted = values.cases?.split(',').map(id => id.trim()).filter(Boolean);
  const unknown = wanted?.filter(id => !cases.some(item => item.id === id)) ?? [];
  if (unknown.length) throw new Error(`Unknown case IDs: ${unknown.join(', ')}`);
  const selected = wanted ? cases.filter(item => wanted.includes(item.id)) : cases;
  const labelProblems = selected.flatMap(checkLabels);
  if (new Set(cases.map(item => item.id)).size !== cases.length) labelProblems.push('duplicate case IDs');

  const prepared: Prepared[] = [];
  for (const item of selected) for (const variant of variantNames) prepared.push(await prepare(item, variant));
  for (const { row, problems } of prepared) {
    const counts = [...groupBy(row.candidates, candidate => candidate.check)].map(([check, list]) => `${check}×${list.length}`).join(' ') || 'none';
    const roles = [...groupBy(row.sources, source => source.role)].map(([role, list]) => `${role}×${list.length}`).join(' ');
    console.error(`${row.caseId} ${row.variant}: candidates ${counts}; sources ${roles}; requests ${row.plannedRequests}`
      + `${row.missingFiles.length ? `; not collected: ${row.missingFiles.join(', ')}` : ''}${problems.length ? `; PROBLEM: ${problems.join('; ')}` : ''}`);
  }
  const problems = [...labelProblems, ...prepared.flatMap(({ row, problems: found }) => found.map(problem => `${row.caseId} ${row.variant}: ${problem}`))];
  const planned = prepared.reduce((total, item) => total + item.row.plannedRequests, 0) * repeats;
  console.error(`${selected.length} cases, ${prepared.length} variants, ${repeats} repeat(s): ${planned} planned provider requests before retries.`);
  if (problems.length) {
    console.error(`Dataset check failed:\n${problems.join('\n')}`);
    process.exitCode = 1;
    return;
  }
  if (!values.live) {
    console.error('Offline dataset check passed. Add --live to send these cases to the configured provider.');
    return;
  }

  const settings = jevSettings();
  if (!settings.apiKey) throw new Error('Set JEV_API_KEY, TYPESAFE_API_KEY, OPENJEV_API_KEY, or OPENROUTER_API_KEY for a live run.');
  const out = resolve(values.out ?? join('.tracecheck', 'calibration', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(out, { recursive: true, mode: 0o700 });
  const rawPath = join(out, 'raw.jsonl');
  const previous = await readRows(rawPath);
  const key = (context: { caseId: string; variant: string; repeat: number }) => `${context.caseId}/${context.variant}/${context.repeat}`;
  const completed = new Set(previous.flatMap(row => row.type === 'report' && !row.incomplete ? [key(row)] : []));
  const recordedCases = new Set(previous.flatMap(row => row.type === 'case' ? [`${row.caseId}/${row.variant}/${row.snapshot}`] : []));
  const budget = { used: previous.filter(row => row.type === 'attempt').length, stoppedAtCap: false };
  let writing = Promise.resolve();
  const record = (row: Row) => { writing = writing.then(() => appendFile(rawPath, JSON.stringify(row) + '\n', { mode: 0o600 })); };

  const runId = randomUUID();
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  record({
    type: 'run', runId, startedAt: new Date().toISOString(), revision, provider: new URL(settings.baseUrl).host, model: settings.model,
    repeats, maxRequests, concurrency, cases: selected.length, node: process.version
  });
  for (const { row } of prepared) if (!recordedCases.has(`${row.caseId}/${row.variant}/${row.snapshot}`)) record(row);

  const jobs = Array.from({ length: repeats }, (_, index) => index + 1)
    .flatMap(repeat => prepared.map(item => ({ ...item, repeat })))
    .filter(job => !completed.has(key({ caseId: job.item.id, variant: job.variant, repeat: job.repeat })));
  const remaining = jobs.reduce((total, job) => total + job.row.plannedRequests, 0);
  if (budget.used + remaining > maxRequests) {
    throw new Error(`${remaining} more requests would exceed the cap: ${budget.used} already used of ${maxRequests}. Lower --repeats, select --cases, or raise --max-requests.`);
  }
  console.error(`Writing ${rawPath}; ${jobs.length} reviews to run, ${budget.used} requests already used.`);

  let finished = 0;
  const review = async (job: (typeof jobs)[number]) => {
    const context: Context = { runId, caseId: job.item.id, variant: job.variant, repeat: job.repeat };
    // Every HTTP attempt, including provider retries, counts toward the cap and is recorded.
    const counted: typeof fetch = async (input, init) => {
      if (budget.used >= maxRequests) {
        budget.stoppedAtCap = true;
        throw new Error('Calibration request cap reached; no request was sent.');
      }
      budget.used++;
      try {
        const response = await fetch(input, init);
        record({ type: 'attempt', ...context, status: response.status });
        return response;
      } catch (error) {
        record({ type: 'attempt', ...context, status: null });
        throw error;
      }
    };
    const jev = new Jev({ ...settings, fetch: counted });
    const evaluator: TypedEvaluator = {
      async evaluate(state, questions, signal) {
        const response = await jev.evaluate(state, questions, signal);
        record({
          type: 'response', ...context, candidateIds: (state as { candidates: Candidate[] }).candidates.map(candidate => candidate.id),
          questionCount: Object.keys(questions).length, model: response.model, usage: response.usage, answers: response.answers
        });
        return response;
      },
    };
    try {
      const report = await reviewAll(job.plan, evaluator, { concurrency: 1, maxRequests: job.row.plannedRequests, signal: AbortSignal.timeout(REVIEW_TIMEOUT_MS) });
      const quality = report.quality;
      record({
        type: 'report', ...context, status: report.status, models: report.models, incomplete: isIncomplete(report), limitations: report.limitations, usage: report.usage,
        decisions: report.decisions.map(decision => ({ id: decision.id, check: decision.check, status: decision.status, confidence: decision.confidence, probability: decision.probability })),
        ...(quality ? {
          quality: {
            priorities: quality.priorities.map(priority => priority.metric), metrics: Object.fromEntries(Object.entries(quality.metrics).map(([dimension, metric]) =>
              [dimension, { status: metric.status, score: metric.score, weakness: metric.weakness?.code, actionable: metric.weakness?.actionable }]))
          }
        } : {})
      });
      console.error(`[${++finished}/${jobs.length}] ${job.item.id} ${job.variant} r${job.repeat}: ${report.decisions.map(decision => decision.status).join(', ') || 'no candidates'}; `
        + `${Object.values(quality?.metrics ?? {}).filter(metric => metric.status === 'assessed').length}/19 scored (${report.usage.elapsedMs} ms)`);
    } catch (error) {
      record({ type: 'error', ...context, message: error instanceof Error ? error.message : String(error) });
      console.error(`[${++finished}/${jobs.length}] ${job.item.id} ${job.variant} r${job.repeat}: failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    for (let index = next++; index < jobs.length && !budget.stoppedAtCap; index = next++) await review(jobs[index]!);
  }));
  record({ type: 'end', runId, finishedAt: new Date().toISOString(), attempts: budget.used, stoppedAtCap: budget.stoppedAtCap });
  await writing;
  console.error(`${budget.used} provider requests used in this run directory.${budget.stoppedAtCap ? ' Stopped at the request cap.' : ''}`);
  console.log(await replay(out));
}

// ---------------------------------------------------------------------------------------------------------------
// Replay: every number below comes from raw.jsonl alone.

type Dimension = { relevance: number; applicability: number; score: number; scoreConfidence: number; weakness: string; weaknessConfidence: number; weaknessProbability: number };
type Evaluation = { caseId: string; variant: VariantName; repeat: number; split: Split; family: Family; labels: QualityLabels; dimensions: Record<string, Dimension> };
type SourceObservation = { caseId: string; variant: VariantName; split: Split; family: Family; check: string; expected: CheckLabel; answers: ChoiceAnswer[] };
type SourceGates = { probability: number; confidence: number };
type QualityGates = { relevance: number; applicability: number; scoreConfidence: number; concernConfidence: number; concernProbability: number };
type Ratio = [number, number];
type SourceMetrics = { recall: Ratio; falsePositives: Ratio; cleared: Ratio; singleRecall: Ratio; singleFalsePositives: Ratio; flips: Ratio; uncertain: Ratio; needsContext: Ratio };
type QualityMetrics = {
  relevant: Ratio; irrelevant: Ratio; perReview: number; withScore: Ratio; spread: number; agreement: Ratio;
  ordered: Ratio; difference: number; defectPriorities: Ratio; cleanPriorities: Ratio;
};
type SourcePoint = SourceGates & { metrics: SourceMetrics };
type QualityPoint = QualityGates & { metrics: QualityMetrics };

const ratio = (items: boolean[]): Ratio => [items.filter(Boolean).length, items.length];
const percent = ([count, total]: Ratio) => total ? `${Math.round((100 * count) / total)}%` : 'n/a';
const counted = (value: Ratio) => `${value[0]}/${value[1]} (${percent(value)})`;
const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : NaN;
const fixed = (value: number, digits = 2) => Number.isNaN(value) ? 'n/a' : value.toFixed(digits);
const hundredths = (from: number, to: number, step: number) => Array.from({ length: Math.round((to - from) / step) + 1 }, (_, index) => (from + index * step) / 100);
const table = (header: string[], rows: string[][]) => [`| ${header.join(' | ')} |`, `| ${header.map((_, index) => index ? '---:' : '---').join(' | ')} |`, ...rows.map(row => `| ${row.join(' | ')} |`)].join('\n');

function quantiles(values: number[]): string {
  if (!values.length) return 'n/a';
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
  return `${at(0.1).toFixed(2)} / ${at(0.5).toFixed(2)} / ${at(0.9).toFixed(2)}`;
}

function sourceStatus(answer: ChoiceAnswer, gates: SourceGates): string {
  // Mirrors decisionsFrom in src/review.ts.
  if (answer.choice === 'needs_context') return 'needs_context';
  const probability = answer.probabilities[answer.choice] ?? 0;
  if (answer.confidence < gates.confidence || probability < gates.probability) return 'uncertain';
  return answer.choice === 'supported' ? 'supported' : 'not_supported';
}

function sourceMetrics(observations: SourceObservation[], gates: SourceGates): SourceMetrics {
  const statuses = observations.map(observation => ({ observation, list: observation.answers.map(answer => sourceStatus(answer, gates)) }));
  const majority = (list: string[], status: string) => list.filter(item => item === status).length * 2 > list.length;
  const defects = statuses.filter(({ observation }) => observation.expected === 'supported');
  const clean = statuses.filter(({ observation }) => observation.expected === 'not_supported');
  const decisions = statuses.flatMap(({ list }) => list);
  const repeated = statuses.filter(({ list }) => list.length > 1);
  return {
    recall: ratio(defects.map(({ list }) => majority(list, 'supported'))),
    falsePositives: ratio(clean.map(({ list }) => majority(list, 'supported'))),
    cleared: ratio(clean.map(({ list }) => majority(list, 'not_supported'))),
    singleRecall: ratio(defects.flatMap(({ list }) => list.map(status => status === 'supported'))),
    singleFalsePositives: ratio(clean.flatMap(({ list }) => list.map(status => status === 'supported'))),
    flips: ratio(repeated.map(({ list }) => new Set(list).size > 1)),
    uncertain: ratio(decisions.map(status => status === 'uncertain')),
    needsContext: ratio(decisions.map(status => status === 'needs_context')),
  };
}

// Mirror transformQuality in src/quality.ts: a concern attaches once relevance and applicability pass, and a score is
// published as assessed only when its confidence passes too.
function scoredUnder(dimension: Dimension, gates: QualityGates): boolean {
  return dimension.relevance >= gates.relevance && dimension.applicability >= gates.applicability && dimension.scoreConfidence >= gates.scoreConfidence;
}

function actionableUnder(dimension: Dimension, gates: QualityGates): boolean {
  return dimension.relevance >= gates.relevance && dimension.applicability >= gates.applicability && dimension.weakness !== 'none'
    && dimension.weaknessConfidence >= gates.concernConfidence && dimension.weaknessProbability >= gates.concernProbability;
}

function qualityMetrics(evaluations: Evaluation[], gates: QualityGates): QualityMetrics {
  const scored = (dimension: Dimension) => scoredUnder(dimension, gates);
  const fires = (evaluation: Evaluation) => Object.values(evaluation.dimensions).some(dimension => actionableUnder(dimension, gates));
  const groups = [...groupBy(evaluations, evaluation => `${evaluation.caseId}/${evaluation.variant}`).values()];
  const spreads: number[] = [];
  const agreement: boolean[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    for (const key of dimensionKeys) {
      const flags = group.map(evaluation => scored(evaluation.dimensions[key]!));
      agreement.push(flags.every(flag => flag === flags[0]));
      const scores = group.flatMap(evaluation => scored(evaluation.dimensions[key]!) ? [evaluation.dimensions[key]!.score] : []);
      if (scores.length > 1) spreads.push(Math.max(...scores) - Math.min(...scores));
    }
  }
  const differences: number[] = [];
  for (const group of groupBy(evaluations, evaluation => evaluation.caseId).values()) {
    const scoresFor = (variant: VariantName, key: string) => group.filter(evaluation => evaluation.variant === variant && scored(evaluation.dimensions[key]!))
      .map(evaluation => evaluation.dimensions[key]!.score);
    for (const key of group[0]!.labels.lowerOnDefect) {
      const clean = scoresFor('clean', key);
      const defect = scoresFor('defect', key);
      if (clean.length && defect.length) differences.push(mean(clean) - mean(defect));
    }
  }
  return {
    relevant: ratio(evaluations.flatMap(evaluation => evaluation.labels.relevant.map(key => scored(evaluation.dimensions[key]!)))),
    irrelevant: ratio(evaluations.flatMap(evaluation => evaluation.labels.irrelevant.map(key => scored(evaluation.dimensions[key]!)))),
    perReview: mean(evaluations.map(evaluation => Object.values(evaluation.dimensions).filter(scored).length)),
    withScore: ratio(evaluations.map(evaluation => Object.values(evaluation.dimensions).some(scored))),
    spread: mean(spreads), agreement: ratio(agreement),
    ordered: ratio(differences.map(difference => difference > 0)), difference: mean(differences),
    defectPriorities: ratio(evaluations.filter(evaluation => evaluation.variant === 'defect').map(fires)),
    cleanPriorities: ratio(evaluations.filter(evaluation => evaluation.variant === 'clean').map(fires)),
  };
}

/** The allowed point with the highest `value`; `tieBreak` orders equal points, preferring the smallest change from current behavior. */
function pick<T>(points: T[], allowed: (point: T) => boolean, value: (point: T) => number, tieBreak: (a: T, b: T) => number): T | undefined {
  return points.filter(allowed).sort((a, b) => value(b) - value(a) || tieBreak(a, b))[0];
}

/** Selection rules that land on the same point share one row. */
function namedPolicies<T>(policies: Array<{ name: string; point: T | undefined }>): Array<{ name: string; point: T }> {
  const merged: Array<{ name: string; point: T }> = [];
  for (const { name, point } of policies) {
    if (point === undefined) continue;
    const same = merged.find(policy => policy.point === point);
    if (same) same.name += ` = ${name}`;
    else merged.push({ name, point });
  }
  return merged;
}

async function replay(dir: string): Promise<string> {
  const rows = await readRows(join(dir, 'raw.jsonl'));
  if (!rows.length) throw new Error(`No raw rows in ${join(dir, 'raw.jsonl')}.`);
  const key = (row: { caseId: string; variant: string; repeat: number }) => `${row.caseId}/${row.variant}/${row.repeat}`;
  const caseRows = new Map<string, CaseRow>();
  const reports = new Map<string, ReportRow>();
  const responses = new Map<string, ResponseRow[]>();
  for (const row of rows) {
    if (row.type === 'case') caseRows.set(`${row.caseId}/${row.variant}`, row);
    if (row.type === 'report') reports.set(key(row), row);
    if (row.type === 'response') responses.set(`${row.runId}|${key(row)}`, [...responses.get(`${row.runId}|${key(row)}`) ?? [], row]);
  }
  const complete = [...reports.values()].filter(report => !report.incomplete).sort((a, b) => key(a).localeCompare(key(b)));
  const evaluations: Evaluation[] = [];
  const observations = new Map<string, SourceObservation>();
  for (const report of complete) {
    const caseRow = caseRows.get(`${report.caseId}/${report.variant}`)!;
    const answers: Record<string, TypedAnswer> = Object.assign({}, ...(responses.get(`${report.runId}|${key(report)}`) ?? []).map(response => response.answers));
    for (const candidate of caseRow.candidates) {
      const answer = answers[`${candidate.id}_assessment`];
      if (answer?.type !== 'choice') throw new Error(`Missing assessment for ${candidate.id} in ${key(report)}.`);
      const id = `${report.caseId}/${report.variant}/${candidate.id}`;
      const observation = observations.get(id) ?? { caseId: report.caseId, variant: report.variant, split: caseRow.split, family: caseRow.family, check: candidate.check, expected: candidate.expected, answers: [] };
      observation.answers.push(answer);
      observations.set(id, observation);
    }
    const dimensionAnswers: Record<string, Dimension> = {};
    for (const dimension of dimensionKeys) {
      const [relevance, applicability, score, weakness] = ['relevance', 'applicability', 'score', 'weakness'].map(part => answers[`quality_${dimension}_${part}`]);
      if (relevance?.type !== 'noul' || applicability?.type !== 'noul' || score?.type !== 'score' || weakness?.type !== 'choice') throw new Error(`Missing quality answers for ${dimension} in ${key(report)}.`);
      dimensionAnswers[dimension] = {
        relevance: relevance.noul, applicability: applicability.noul, score: Math.round((score.score + 1) * 10) / 10, scoreConfidence: score.confidence,
        weakness: weakness.choice, weaknessConfidence: weakness.confidence, weaknessProbability: weakness.probabilities[weakness.choice] ?? 0
      };
    }
    evaluations.push({ caseId: report.caseId, variant: report.variant, repeat: report.repeat, split: caseRow.split, family: caseRow.family, labels: caseRow.quality, dimensions: dimensionAnswers });
  }
  const sourceObservations = [...observations.values()];
  const bySplit = <T extends { split: Split }>(items: T[], split: Split | 'all') => split === 'all' ? items : items.filter(item => item.split === split);
  const sections: string[] = [];

  // Dataset, requests, and cost.
  const caseList = [...caseRows.values()];
  const pairs = (split: Split | 'all', quality: boolean) => new Set(bySplit(caseList, split).filter(row => (row.family === 'quality-only') === quality).map(row => row.caseId)).size;
  sections.push('### Dataset', table(['Split', 'Source-check pairs', 'Quality-only pairs', 'JavaScript pairs', 'Defect candidates', 'Clean candidates', 'Completed reviews'],
    (['development', 'holdout', 'all'] as const).map(split => [split === 'all' ? 'All' : split[0]!.toUpperCase() + split.slice(1), String(pairs(split, false)), String(pairs(split, true)),
    String(new Set(bySplit(caseList, split).filter(row => row.language === 'javascript').map(row => row.caseId)).size),
    String(bySplit(caseList, split).filter(row => row.variant === 'defect').reduce((total, row) => total + row.candidates.length, 0)),
    String(bySplit(caseList, split).filter(row => row.variant === 'clean').reduce((total, row) => total + row.candidates.length, 0)),
    String(bySplit(evaluations, split).length)])));
  const attempts = rows.filter(row => row.type === 'attempt');
  const inputTokens = [...responses.values()].flat().reduce((total, row) => total + row.usage.input_tokens, 0);
  const outputTokens = [...responses.values()].flat().reduce((total, row) => total + row.usage.output_tokens, 0);
  const elapsed = complete.map(report => report.usage.elapsedMs).sort((a, b) => a - b);
  const models = [...new Set(complete.flatMap(report => report.models))].sort();
  const failures = [...reports.values()].filter(report => report.incomplete).length + rows.filter(row => row.type === 'error').length;
  sections.push('### Requests and cost', table(['Model', 'Provider requests', 'Retried or failed attempts', 'Failed reviews', 'Input tokens', 'Output tokens', 'Estimated cost', 'Review p50 / p95'],
    [[models.join(', ') || 'n/a', String(attempts.length), String(attempts.filter(row => row.status !== 200).length), String(failures), inputTokens.toLocaleString('en-US'),
    outputTokens.toLocaleString('en-US'), `$${((inputTokens / 1_000_000) * INPUT_DOLLARS_PER_MILLION).toFixed(4)}`,
    elapsed.length ? `${elapsed[Math.floor(elapsed.length / 2)]} / ${elapsed[Math.min(elapsed.length - 1, Math.floor(elapsed.length * 0.95))]} ms` : 'n/a']]),
    `Cost counts input tokens at $${INPUT_DOLLARS_PER_MILLION} per million; output tokens are listed but not priced.`);

  // Baseline.
  const sourceRow = (label: string, metrics: SourceMetrics) => [label, counted(metrics.recall), counted(metrics.falsePositives), counted(metrics.singleRecall),
    counted(metrics.singleFalsePositives), counted(metrics.flips), counted(metrics.uncertain), counted(metrics.needsContext)];
  const sourceHeader = ['Split', 'Recall (majority)', 'False positives (majority)', 'Recall (single review)', 'False positives (single review)', 'Flips across repeats', 'Uncertain', 'Needs context'];
  const current: SourceGates = { probability: CURRENT.probability, confidence: CURRENT.confidence };
  sections.push(`### Baseline source checks (probability ≥ ${CURRENT.probability}, confidence ≥ ${CURRENT.confidence})`,
    table(sourceHeader, (['development', 'holdout', 'all'] as const).map(split => sourceRow(split === 'all' ? 'All' : split[0]!.toUpperCase() + split.slice(1), sourceMetrics(bySplit(sourceObservations, split), current)))),
    table(['Family, all splits', ...sourceHeader.slice(1)], (['zero-divisor', 'swallowed-failure', 'unhandled-json'] as const)
      .map(family => sourceRow(family, sourceMetrics(sourceObservations.filter(observation => observation.family === family), current)))),
    'Majority columns count a candidate once, as supported when most of its repeats were supported. Single-review columns count every repeat separately, which is what one user review sees.');
  const qualityHeader = ['Split', 'Relevant scored', 'Irrelevant scored', 'Scored per review', 'Reviews with a score', 'Score spread', 'Gate agreement', 'Clean above defect', 'Clean − defect', 'Priority on defect', 'Priority on clean'];
  const qualityRow = (label: string, metrics: QualityMetrics) => [label, counted(metrics.relevant), counted(metrics.irrelevant), fixed(metrics.perReview, 1),
    counted(metrics.withScore), fixed(metrics.spread), percent(metrics.agreement), counted(metrics.ordered), fixed(metrics.difference), counted(metrics.defectPriorities), counted(metrics.cleanPriorities)];
  const currentQuality: QualityGates = {
    relevance: CURRENT.relevance, applicability: CURRENT.applicability, scoreConfidence: CURRENT.scoreConfidence,
    concernConfidence: CURRENT.concernConfidence, concernProbability: CURRENT.concernProbability
  };
  sections.push(`### Baseline quality (relevance ≥ ${CURRENT.relevance}, applicability ≥ ${CURRENT.applicability}, score confidence ≥ ${CURRENT.scoreConfidence})`,
    table(qualityHeader, (['development', 'holdout', 'all'] as const).map(split => qualityRow(split === 'all' ? 'All' : split[0]!.toUpperCase() + split.slice(1), qualityMetrics(bySplit(evaluations, split), currentQuality)))),
    'Scored means published as assessed. Score spread is the mean range of one dimension\'s published scores across repeats. Gate agreement is the share of dimensions scored in every repeat or in none. Clean above defect compares, per pair, the mean published score on dimensions labeled lower-on-defect, when both variants published one. Priorities use the concern gates (confidence ≥ 0.6, probability ≥ 0.8).');

  // Raw signals.
  const selected = (answer: ChoiceAnswer) => answer.probabilities[answer.choice] ?? 0;
  const answersFor = (expected: CheckLabel) => sourceObservations.filter(observation => observation.expected === expected).flatMap(observation => observation.answers);
  sections.push('### Source-check answers by label (all splits)', table(['Label', 'Decisions', 'Chose supported', 'Chose not supported', 'Chose needs context', 'Selected probability p10 / p50 / p90', 'Confidence p10 / p50 / p90'],
    (['supported', 'not_supported'] as const).map(expected => {
      const list = answersFor(expected);
      return [expected === 'supported' ? 'Defect' : 'Clean', String(list.length), ...['supported', 'not_supported', 'needs_context'].map(choice => counted(ratio(list.map(answer => answer.choice === choice)))),
      quantiles(list.map(selected)), quantiles(list.map(answer => answer.confidence))];
    })));
  const bins = [[0, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]] as const;
  const supportedAnswers = sourceObservations.flatMap(observation => observation.answers.filter(answer => answer.choice === 'supported').map(answer => ({ answer, defect: observation.expected === 'supported' })));
  sections.push('### How often a supported choice was a real defect (all splits)', table(['Selected probability', 'Supported choices', 'On defects', 'On clean variants'],
    bins.map(([low, high]) => {
      const inBin = supportedAnswers.filter(({ answer }) => selected(answer) >= low && selected(answer) < high);
      return [high > 1 ? `≥ ${low}` : `${low}–${high}`, String(inBin.length), counted(ratio(inBin.map(item => item.defect))), counted(ratio(inBin.map(item => !item.defect)))];
    })));
  const signal = (pick: (dimension: Dimension) => number, which: 'relevant' | 'irrelevant' | 'unlabeled') => evaluations.flatMap(evaluation => dimensionKeys
    .filter(dimension => which === 'unlabeled' ? !evaluation.labels.relevant.includes(dimension) && !evaluation.labels.irrelevant.includes(dimension) : evaluation.labels[which].includes(dimension))
    .map(dimension => pick(evaluation.dimensions[dimension]!)));
  sections.push('### Quality answers by label (all splits, p10 / p50 / p90)', table(['Dimension label', 'Answers', 'Relevance', 'Applicability', 'Score confidence', 'Score'],
    (['relevant', 'irrelevant', 'unlabeled'] as const).map(which => [which[0]!.toUpperCase() + which.slice(1), String(signal(dimension => dimension.relevance, which).length),
    quantiles(signal(dimension => dimension.relevance, which)), quantiles(signal(dimension => dimension.applicability, which)),
    quantiles(signal(dimension => dimension.scoreConfidence, which)), quantiles(signal(dimension => dimension.score, which))])));

  // Source-check grid.
  const probabilities = hundredths(50, 80, 5);
  const confidences = hundredths(30, 60, 5);
  const sourceGrid = Object.fromEntries(splits.map(split => [split, probabilities.flatMap(probability => confidences.map(confidence =>
  ({ probability, confidence, metrics: sourceMetrics(bySplit(sourceObservations, split), { probability, confidence }) })))]));
  const share = ([count, total]: Ratio) => total ? count / total : 0;
  const stricterSource = (a: SourcePoint, b: SourcePoint) => share(a.metrics.flips) - share(b.metrics.flips) || b.probability - a.probability || b.confidence - a.confidence;
  const sourcePolicies = namedPolicies([
    { name: 'Current', point: sourceGrid.development!.find(point => point.probability === CURRENT.probability && point.confidence === CURRENT.confidence) },
    { name: 'Strict', point: pick(sourceGrid.development!, point => point.metrics.singleFalsePositives[0] === 0, point => share(point.metrics.recall), stricterSource) },
    { name: 'Balanced', point: pick(sourceGrid.development!, () => true, point => share(point.metrics.recall) - share(point.metrics.falsePositives), stricterSource) },
  ]);
  for (const split of splits) {
    sections.push(`### Source-check grid, ${split} (recall · false positives · flips, majority of repeats)`, table(['Probability \\ confidence', ...confidences.map(value => `≥ ${value.toFixed(2)}`)],
      probabilities.map(probability => [`≥ ${probability.toFixed(2)}`, ...confidences.map(confidence => {
        const { metrics } = sourceGrid[split]!.find(point => point.probability === probability && point.confidence === confidence)!;
        const cell = `${percent(metrics.recall)} · ${percent(metrics.falsePositives)} · ${percent(metrics.flips)}`;
        return sourcePolicies.some(({ point }) => point.probability === probability && point.confidence === confidence) ? `**${cell}**` : cell;
      })])));
  }
  sections.push(`Bold cells are the candidate policies below, chosen on development data: ${sourcePolicies.map(policy => `${policy.name} (${policy.point.probability.toFixed(2)} / ${policy.point.confidence.toFixed(2)})`).join(', ')}.`);
  sections.push(`### Probability gate at confidence ≥ ${CURRENT.confidence.toFixed(2)} (single reviews)`, table(['Probability', 'Dev recall', 'Dev false positives', 'Dev uncertain',
    'Holdout recall', 'Holdout false positives', 'Holdout uncertain', 'Flips, both splits'], probabilities.map(probability => {
      const [development, holdout] = splits.map(split => sourceGrid[split]!.find(point => point.probability === probability && point.confidence === CURRENT.confidence)!.metrics);
      return [`≥ ${probability.toFixed(2)}`, counted(development!.singleRecall), counted(development!.singleFalsePositives), counted(development!.uncertain),
      counted(holdout!.singleRecall), counted(holdout!.singleFalsePositives), counted(holdout!.uncertain), counted([development!.flips[0] + holdout!.flips[0], development!.flips[1] + holdout!.flips[1]])];
    })));
  const holdoutPoint = (point: SourceGates) => sourceGrid.holdout!.find(item => item.probability === point.probability && item.confidence === point.confidence)!.metrics;
  sections.push('### Candidate source-check policies', table(['Policy', 'Probability', 'Confidence', 'Dev recall', 'Dev false positives', 'Dev single-review false positives', 'Dev flips',
    'Holdout recall', 'Holdout false positives', 'Holdout single-review recall', 'Holdout single-review false positives', 'Holdout flips', 'Holdout uncertain'],
    sourcePolicies.map(({ name, point }) => {
      const holdout = holdoutPoint(point);
      return [name, `≥ ${point.probability.toFixed(2)}`, `≥ ${point.confidence.toFixed(2)}`, counted(point.metrics.recall), counted(point.metrics.falsePositives), counted(point.metrics.singleFalsePositives),
        counted(point.metrics.flips), counted(holdout.recall), counted(holdout.falsePositives), counted(holdout.singleRecall), counted(holdout.singleFalsePositives), counted(holdout.flips), counted(holdout.uncertain)];
    })), 'Strict: the highest development recall with no clean candidate supported in any development review. Balanced: the highest development recall minus false-positive rate. Ties go to fewer flips, then to stricter gates.');
  sections.push('### Candidate source-check policies by family (both splits)', table(['Policy', 'Family', 'Recall (majority)', 'Recall (single review)', 'False positives (single review)', 'Flips'],
    sourcePolicies.flatMap(({ name, point }) => (['zero-divisor', 'swallowed-failure', 'unhandled-json'] as const).map(family => {
      const metrics = sourceMetrics(sourceObservations.filter(observation => observation.family === family), point);
      return [name, family, counted(metrics.recall), counted(metrics.singleRecall), counted(metrics.singleFalsePositives), counted(metrics.flips)];
    }))));

  // Quality grid.
  const gateValues = hundredths(30, 80, 10);
  const scoreConfidences = hundredths(30, 60, 10);
  const qualityGrid: Record<string, QualityPoint[]> = Object.fromEntries(splits.map(split => [split, gateValues.flatMap(relevance => gateValues.flatMap(applicability => scoreConfidences.map(scoreConfidence => {
    const gates = { relevance, applicability, scoreConfidence, concernConfidence: CURRENT.concernConfidence, concernProbability: CURRENT.concernProbability };
    return { ...gates, metrics: qualityMetrics(bySplit(evaluations, split), gates) };
  })))]));
  const gatesLabel = (point: Pick<QualityGates, 'relevance' | 'applicability' | 'scoreConfidence'>) => `${point.relevance.toFixed(1)} / ${point.applicability.toFixed(1)} / ${point.scoreConfidence.toFixed(1)}`;
  const findQuality = (split: Split, gates: Pick<QualityGates, 'relevance' | 'applicability' | 'scoreConfidence'>) => qualityGrid[split]!.find(point => gatesLabel(point) === gatesLabel(gates))!;
  const gateSum = (point: QualityPoint) => point.relevance + point.applicability + point.scoreConfidence;
  const stricterQuality = (a: QualityPoint, b: QualityPoint) => gateSum(b) - gateSum(a) || b.relevance - a.relevance || b.applicability - a.applicability || b.scoreConfidence - a.scoreConfidence;
  const qualityPolicies = namedPolicies([
    { name: 'Current', point: findQuality('development', CURRENT) },
    { name: 'Moderate', point: pick(qualityGrid.development!, point => share(point.metrics.relevant) >= 0.5 && share(point.metrics.irrelevant) <= 0.05, gateSum, stricterQuality) },
    { name: 'Permissive', point: pick(qualityGrid.development!, () => true, point => share(point.metrics.relevant) - share(point.metrics.irrelevant), stricterQuality) },
  ]);
  for (const split of splits) {
    sections.push(`### Quality grid, ${split}, relevance ≥ ${CURRENT.relevance.toFixed(1)} (relevant scored · irrelevant scored · clean above defect)`,
      table(['Applicability \\ score confidence', ...scoreConfidences.map(value => `≥ ${value.toFixed(1)}`)], [...gateValues].reverse().map(applicability => [`≥ ${applicability.toFixed(1)}`,
      ...scoreConfidences.map(scoreConfidence => {
        const point = findQuality(split, { relevance: CURRENT.relevance, applicability, scoreConfidence });
        const cell = `${percent(point.metrics.relevant)} · ${percent(point.metrics.irrelevant)} · ${percent(point.metrics.ordered)}`;
        return qualityPolicies.some(policy => gatesLabel(policy.point) === gatesLabel(point)) ? `**${cell}**` : cell;
      })])));
  }
  sections.push(`Bold cells are the candidate policies below, chosen on development data (relevance / applicability / score confidence): ${qualityPolicies.map(policy => `${policy.name} (${gatesLabel(policy.point)})`).join(', ')}.`);
  const loosest = { applicability: gateValues[0]!, scoreConfidence: scoreConfidences[0]! };
  sections.push('### Relevance gate, development (relevant scored · irrelevant scored)', table(['Relevance', `Applicability ≥ ${CURRENT.applicability.toFixed(1)}, score confidence ≥ ${CURRENT.scoreConfidence.toFixed(1)}`,
    `Applicability ≥ ${loosest.applicability.toFixed(1)}, score confidence ≥ ${loosest.scoreConfidence.toFixed(1)}`], [...gateValues].reverse().map(relevance => [`≥ ${relevance.toFixed(1)}`,
    ...[{ applicability: CURRENT.applicability, scoreConfidence: CURRENT.scoreConfidence }, loosest].map(gates => {
      const { metrics } = findQuality('development', { relevance, ...gates });
      return `${percent(metrics.relevant)} · ${percent(metrics.irrelevant)}`;
    })])));
  sections.push('### Candidate quality policies', table(['Policy', 'Gates (relevance / applicability / score confidence)', 'Split', ...qualityHeader.slice(1)],
    qualityPolicies.flatMap(({ name, point }) => [
      [name, gatesLabel(point), ...qualityRow('Development', point.metrics)],
      [name, gatesLabel(point), ...qualityRow('Holdout', findQuality('holdout', point).metrics)],
    ])), 'Moderate: the strictest gates that score at least half of the labeled-relevant dimensions on development data, with at most 5% of labeled-irrelevant dimensions scored. Permissive: the largest gap between the two shares. Ties go to stricter gates.');
  const median = (values: number[]) => values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!.toFixed(2) : 'n/a';
  sections.push('### Quality by dimension (all splits)', table(['Dimension', 'Labeled relevant', 'Labeled irrelevant', 'Median relevance', 'Median applicability', 'Median score confidence',
    ...qualityPolicies.map(policy => `Scored under ${policy.name}`)], dimensionKeys.map(dimension => {
      const values = evaluations.map(evaluation => evaluation.dimensions[dimension]!);
      return [dimension, String(evaluations.filter(evaluation => evaluation.labels.relevant.includes(dimension)).length),
        String(evaluations.filter(evaluation => evaluation.labels.irrelevant.includes(dimension)).length), median(values.map(value => value.relevance)),
        median(values.map(value => value.applicability)), median(values.map(value => value.scoreConfidence)),
        ...qualityPolicies.map(({ point }) => counted(ratio(values.map(value => scoredUnder(value, point)))))];
    })), 'Labeled counts are reviews in which the dimension carries that label.');
  const reviewsOf = (variant: VariantName) => evaluations.filter(evaluation => evaluation.variant === variant);
  sections.push('### Actionable concerns by dimension (all splits, defect reviews · clean reviews)', table(['Dimension', ...qualityPolicies.map(policy => policy.name)],
    dimensionKeys.flatMap(dimension => {
      const cells = qualityPolicies.map(({ point }) => (['defect', 'clean'] as const)
        .map(variant => reviewsOf(variant).filter(evaluation => actionableUnder(evaluation.dimensions[dimension]!, point)).length).join(' · '));
      return cells.every(cell => cell === '0 · 0') ? [] : [[dimension, ...cells]];
    })), `Each cell counts the reviews, of ${reviewsOf('defect').length} defect and ${reviewsOf('clean').length} clean, in which the dimension had an actionable concern (confidence ≥ ${CURRENT.concernConfidence}, probability ≥ ${CURRENT.concernProbability}). Dimensions with none are omitted.`);
  const concernPolicy = qualityPolicies.at(-1)!;
  sections.push(`### Concern gates at the ${concernPolicy.name} quality gates, development (priority on defect · priority on clean)`, table(['Concern probability \\ confidence', ...hundredths(30, 60, 10).map(value => `≥ ${value.toFixed(1)}`)],
    hundredths(50, 80, 10).reverse().map(concernProbability => [`≥ ${concernProbability.toFixed(1)}`, ...hundredths(30, 60, 10).map(concernConfidence => {
      const metrics = qualityMetrics(bySplit(evaluations, 'development'), { ...concernPolicy.point, concernConfidence, concernProbability });
      return `${percent(metrics.defectPriorities)} · ${percent(metrics.cleanPriorities)}`;
    })])));

  // Replay check against the reports the live run produced.
  let decisionMatches = 0;
  let decisionTotal = 0;
  let metricMatches = 0;
  let metricTotal = 0;
  for (const report of complete) {
    for (const decision of report.decisions) {
      const answer = observations.get(`${report.caseId}/${report.variant}/${decision.id}`)?.answers[complete.filter(item => item.caseId === report.caseId && item.variant === report.variant).indexOf(report)];
      decisionTotal++;
      if (answer && sourceStatus(answer, current) === decision.status) decisionMatches++;
    }
    const evaluation = evaluations.find(item => item.caseId === report.caseId && item.variant === report.variant && item.repeat === report.repeat)!;
    for (const [dimension, metric] of Object.entries(report.quality?.metrics ?? {})) {
      metricTotal++;
      if (scoredUnder(evaluation.dimensions[dimension]!, currentQuality) === (metric.status === 'assessed')) metricMatches++;
    }
  }
  sections.push('### Replay check', `Replaying the current policy from raw answers reproduces ${decisionMatches} of ${decisionTotal} live source-check decisions and ${metricMatches} of ${metricTotal} live quality assessed/unassessed outcomes.`);

  const markdown = sections.join('\n\n') + '\n';
  await writeFile(join(dir, 'tables.md'), markdown);
  await writeFile(join(dir, 'summary.json'), JSON.stringify({
    current: CURRENT, dimensions: dimensionKeys, sourceGrid, qualityGrid,
    sourcePolicies: sourcePolicies.map(policy => ({ name: policy.name, probability: policy.point.probability, confidence: policy.point.confidence })),
    qualityPolicies: qualityPolicies.map(policy => ({ name: policy.name, relevance: policy.point.relevance, applicability: policy.point.applicability, scoreConfidence: policy.point.scoreConfidence }))
  }, null, 2) + '\n');
  return markdown;
}

// Dispatch last, so every module-level constant above is initialized before run or replay reads it.
const [mode, ...args] = process.argv.slice(2);
if (mode === 'run') await run(args);
else if (mode === 'replay') {
  if (!args[0]) throw new Error('Pass the run directory: npm run calibrate -- replay .tracecheck/calibration/<timestamp>');
  console.log(await replay(resolve(args[0])));
} else {
  console.log('Usage: npm run calibrate -- run [--live] [--repeats 3] [--max-requests 400] [--concurrency 4] [--cases id,id] [--out dir]\n       npm run calibrate -- replay <run directory>');
  process.exitCode = mode ? 1 : 0;
}

