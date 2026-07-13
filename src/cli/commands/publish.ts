import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import type { NewFinding, PublishSelection } from '../../core/types.js';
import { sameCommitSha } from '../../core/commits.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { parsePatch } from '../../workspace/patch-parser.js';
import { validateFindings, formatValidationErrors } from '../../workspace/finding-validator.js';
import { createOrchestrator, getRepoFromGit, handleError } from '../helpers.js';
import { computeContentHash } from '../../workspace/thread-digest.js';
import { mergeWithMarkers, MARKER_START, MARKER_END } from '../../workspace/description-summary.js';
import { buildFindingHeader } from '../../workspace/finding-formatter.js';
import { loadPublishMaterial, type PublishMaterial } from '../../workspace/publish-material.js';
import {
  executePublishPlan,
  selectAllPublishMaterial,
  type PublishExecutionResult,
  type PublishPlanProgress,
} from '../../orchestration/publish-plan.js';
import type { ReviewOrchestrator } from '../../orchestration/orchestrator.js';
import {
  createNodePublishTerminal,
  runGuidedPublish,
  runStalePublishPrompt,
  type GuidedPublishModel,
  type PublishTerminal,
} from './publish-tui.js';

export { mergeWithMarkers, MARKER_START, MARKER_END };

const DEFAULT_REPLIES_FILE = '.revpack/outputs/replies.json';
const DEFAULT_FINDINGS_FILE = '.revpack/outputs/new-findings.json';
const DEFAULT_NOTE_FILE = '.revpack/outputs/note.md';
const DEFAULT_SUMMARY_FILE = '.revpack/outputs/summary.md';
const DEFAULT_LATEST_PATCH_FILE = '.revpack/diffs/latest.patch';

function workspacePath(filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
}

// ─── JSON helpers ────────────────────────────────────────

interface ReplyEntry {
  threadId: string;
  body: string;
  resolve?: boolean;
}

interface PublishSummaryOptions {
  from?: string;
  replace?: boolean;
  repo?: string;
}

function normalizeThreadRef(ref: string): string {
  return ref.trim().toUpperCase();
}

function findReplyEntryIndex(entries: ReplyEntry[], requestedRef: string, resolvedRef: string): number {
  const normalizedRequested = normalizeThreadRef(requestedRef);
  return entries.findIndex(
    (entry) => normalizeThreadRef(entry.threadId) === normalizedRequested || entry.threadId.trim() === resolvedRef,
  );
}

function requirePublishableContent(content: string, label: string): string {
  if (!content.trim()) {
    throw new Error(`${label} is empty; nothing to publish.`);
  }
  return content;
}

async function loadRepliesJson(filePath: string, options: { allowMissing: boolean }): Promise<ReplyEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (options.allowMissing) return [];
      throw new Error(`No replies file found at ${filePath}.`, { cause: error });
    }
    throw new Error(`Could not read replies file at ${filePath}.`, { cause: error });
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as ReplyEntry[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of { threadId, body, resolve? } objects`);
  }
}

async function saveRepliesJson(
  filePath: string,
  entries: ReplyEntry[],
  options?: { deleteWhenEmpty?: boolean },
): Promise<void> {
  if (options?.deleteWhenEmpty && entries.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

async function loadNewFindings(filePath: string, options: { allowMissing: boolean }): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    if (options.allowMissing) return [];
    throw new Error(`No findings file found at ${filePath}.`);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as unknown[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of finding objects`);
  }
}

async function saveFindings(
  filePath: string,
  entries: NewFinding[],
  options?: { deleteWhenEmpty?: boolean },
): Promise<void> {
  if (options?.deleteWhenEmpty && entries.length === 0) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─── Shared publish logic (reusable by subcommands & parent) ────

async function publishReplies(opts: {
  thread?: string;
  body?: string;
  resolve?: boolean;
  from?: string;
  noRefresh?: boolean;
}): Promise<number> {
  const orchestrator = await createOrchestrator();
  const defaultRepo = await getRepoFromGit();
  const repliesFile = workspacePath(opts.from ?? DEFAULT_REPLIES_FILE);
  const usingDefaultRepliesFile = !opts.from;

  if (opts.thread) {
    // Single thread mode
    let body: string;
    let shouldResolve = opts.resolve ?? false;
    let entries: ReplyEntry[] | undefined;
    let matchedIdx = -1;

    if (opts.body) {
      body = opts.body;
    } else {
      entries = await loadRepliesJson(repliesFile, { allowMissing: usingDefaultRepliesFile });
      const resolved = await orchestrator.resolveThreadRef(opts.thread);
      matchedIdx = findReplyEntryIndex(entries, opts.thread, resolved);
      if (matchedIdx === -1) {
        console.error(chalk.red(`No reply found for "${opts.thread}" in ${repliesFile}`));
        console.error(chalk.dim('Available: ' + entries.map((e) => e.threadId).join(', ')));
        process.exit(1);
      }
      body = entries[matchedIdx].body;
      shouldResolve = opts.resolve ?? entries[matchedIdx].resolve ?? false;
    }

    await orchestrator.publishReply(undefined, opts.thread, body, defaultRepo);
    console.log(chalk.green(`✓ Replied to ${opts.thread}`));

    const ws = new WorkspaceManager(process.cwd());
    if (entries && matchedIdx >= 0) {
      entries.splice(matchedIdx, 1);
      await saveRepliesJson(repliesFile, entries, { deleteWhenEmpty: usingDefaultRepliesFile });
    }
    await ws.appendPublishedAction({
      type: 'reply',
      providerThreadId: opts.thread,
      title: body.split('\n')[0].slice(0, 80),
      publishedAt: new Date().toISOString(),
    });
    if (shouldResolve) {
      await orchestrator.resolveThread(undefined, opts.thread, defaultRepo);
      console.log(chalk.dim('  thread resolved'));
      await ws.appendPublishedAction({
        type: 'resolve',
        providerThreadId: opts.thread,
        title: 'Thread resolved',
        publishedAt: new Date().toISOString(),
      });
    }
    return 1;
  }

  // Batch mode
  const entries = await loadRepliesJson(repliesFile, { allowMissing: usingDefaultRepliesFile });
  if (entries.length === 0) return 0;

  let posted = 0;
  const ws = new WorkspaceManager(process.cwd());
  const remaining: ReplyEntry[] = [...entries];
  for (const entry of entries) {
    try {
      await orchestrator.publishReply(undefined, entry.threadId, entry.body, defaultRepo);
      console.log(chalk.green(`  ✓ ${entry.threadId}`));
      posted++;
      const remainingIndex = remaining.indexOf(entry);
      if (remainingIndex !== -1) {
        remaining.splice(remainingIndex, 1);
        await saveRepliesJson(repliesFile, remaining, { deleteWhenEmpty: usingDefaultRepliesFile });
      }
      await ws.appendPublishedAction({
        type: 'reply',
        providerThreadId: entry.threadId,
        title: entry.body.split('\n')[0].slice(0, 80),
        publishedAt: new Date().toISOString(),
      });
      if (entry.resolve || opts.resolve) {
        try {
          await orchestrator.resolveThread(undefined, entry.threadId, defaultRepo);
          console.log(chalk.dim('    resolved'));
          await ws.appendPublishedAction({
            type: 'resolve',
            providerThreadId: entry.threadId,
            title: 'Thread resolved',
            publishedAt: new Date().toISOString(),
          });
        } catch (err) {
          console.error(
            chalk.red(
              `    resolve failed: ${err instanceof Error ? err.message : String(err)} (resolve will not be retried)`,
            ),
          );
        }
      }
    } catch (err) {
      console.error(chalk.red(`  ✗ ${entry.threadId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  await saveRepliesJson(repliesFile, remaining, { deleteWhenEmpty: usingDefaultRepliesFile });
  if (posted > 0) console.log(chalk.green(`${posted} replies published`));
  return posted;
}

async function loadAndValidateFindings(
  filePath: string,
  options?: { allowMissing?: boolean },
): Promise<{ findings: NewFinding[]; resolvedPath: string }> {
  const resolvedPath = workspacePath(filePath);
  const rawFindings = await loadNewFindings(resolvedPath, { allowMissing: options?.allowMissing ?? false });
  if (rawFindings.length === 0) return { findings: [], resolvedPath };

  const patchPath = workspacePath(DEFAULT_LATEST_PATCH_FILE);
  let patchContent: string;
  try {
    patchContent = await fs.readFile(patchPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot validate findings: ${patchPath} not found.\n` +
        `Run \`revpack prepare\` first to generate the diff bundle.`,
    );
  }

  const lineMap = parsePatch(patchContent);
  const { valid: findings, errors } = validateFindings(rawFindings, lineMap);

  if (errors.length > 0) {
    console.error(chalk.red(`\n${errors.length} finding(s) failed validation:\n`));
    console.error(formatValidationErrors(errors));
    throw new Error(
      `${errors.length} invalid finding(s) in ${filePath}. Fix the positions and retry.\n` +
        `The output file has not been modified.`,
    );
  }

  return { findings, resolvedPath };
}

function annotateFindingBodies(findings: NewFinding[]): NewFinding[] {
  return findings.map((f) => ({
    ...f,
    body: buildFindingHeader(f.severity, f.category) + f.body,
  }));
}

async function trackFindingActions(ws: WorkspaceManager, findings: NewFinding[], threadIds?: string[]): Promise<void> {
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    await ws.appendPublishedAction({
      type: 'finding',
      providerThreadId: threadIds?.[i],
      location: { oldPath: f.oldPath, newPath: f.newPath, oldLine: f.oldLine, newLine: f.newLine },
      severity: f.severity,
      category: f.category,
      title: f.body.split('\n')[0].slice(0, 80),
      publishedAt: new Date().toISOString(),
    });
  }
}

async function clearDefaultReviewOutput(clearDefaultOutput = true): Promise<void> {
  if (clearDefaultOutput) {
    await fs.rm(workspacePath(DEFAULT_NOTE_FILE), { force: true });
  }
}

async function readOptionalTextFile(filePath: string): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: await fs.readFile(workspacePath(filePath), 'utf-8') };
  } catch {
    return { exists: false, content: '' };
  }
}

async function loadDefaultReviewNote(): Promise<{
  filePath: string;
  content: string;
  exists: boolean;
}> {
  const note = await readOptionalTextFile(DEFAULT_NOTE_FILE);
  return { filePath: DEFAULT_NOTE_FILE, content: note.content, exists: note.exists };
}

async function publishFindings(opts: { from?: string; dryRun?: boolean; noRefresh?: boolean }): Promise<number> {
  const filePath = opts.from ?? DEFAULT_FINDINGS_FILE;
  const usingDefaultFindingsFile = !opts.from;
  const { findings, resolvedPath } = await loadAndValidateFindings(filePath, {
    allowMissing: usingDefaultFindingsFile,
  });
  if (findings.length === 0) return 0;

  if (opts.dryRun) {
    console.log(chalk.bold(`${findings.length} finding(s) would be published:\n`));
    for (const f of findings) {
      const displayPath = f.newPath || f.oldPath;
      console.log(`  ${chalk.yellow(f.severity)} ${chalk.dim(f.category)} ${displayPath}:${f.newLine ?? f.oldLine}`);
      console.log(`    ${f.body.split('\n')[0].slice(0, 100)}`);
    }
    return 0;
  }

  const orchestrator = await createOrchestrator();
  const defaultRepo = await getRepoFromGit();
  const ws = new WorkspaceManager(process.cwd());

  let published = 0;
  const remaining: NewFinding[] = [];
  for (const finding of findings) {
    try {
      const annotated = { ...finding, body: buildFindingHeader(finding.severity, finding.category) + finding.body };
      const createdThreadId = await orchestrator.publishFinding(annotated, defaultRepo);
      const displayPath = finding.newPath || finding.oldPath;
      console.log(chalk.green(`  \u2713 ${displayPath}:${finding.newLine ?? finding.oldLine} (${finding.severity})`));
      published++;
      await trackFindingActions(ws, [annotated], [createdThreadId]);
    } catch (err) {
      const displayPath = finding.newPath || finding.oldPath;
      console.error(
        chalk.red(
          `  \u2717 ${displayPath}:${finding.newLine ?? finding.oldLine}: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
      remaining.push(finding);
    }
  }
  await saveFindings(resolvedPath, remaining, { deleteWhenEmpty: usingDefaultFindingsFile });
  if (published > 0) console.log(chalk.green(`${published}/${findings.length} findings published`));
  return published;
}

async function publishDescription(opts: { from?: string; replace?: boolean; repo?: string }): Promise<number> {
  let content: string;
  let usedSummary = false;
  let ws: WorkspaceManager | undefined;
  if (opts.from) {
    content = await fs.readFile(workspacePath(opts.from), 'utf-8');
  } else {
    usedSummary = true;
    try {
      content = await fs.readFile(workspacePath(DEFAULT_SUMMARY_FILE), 'utf-8');
    } catch {
      throw new Error('No summary found. Run `revpack prepare` first.');
    }
  }
  requirePublishableContent(content, usedSummary ? DEFAULT_SUMMARY_FILE : (opts.from ?? 'description content'));

  if (usedSummary && !opts.replace) {
    ws = new WorkspaceManager(process.cwd());
    const summaryState = await ws.getOutputState('summary');
    if (summaryState === 'published') {
      console.log(chalk.dim('  (summary already published)'));
      return 0;
    }
  }

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? (await getRepoFromGit());

  let body: string;
  if (opts.replace) {
    body = content!;
  } else {
    const target = await orchestrator.open(undefined, defaultRepo);
    body = mergeWithMarkers(target.description, content!, {
      markerStyle: target.provider === 'bitbucket-cloud' ? 'markdown-heading' : 'html',
    });
  }

  await orchestrator.updateDescription(undefined, body, defaultRepo);
  console.log(chalk.green(`✓ Description updated${opts.replace ? '' : ' (marked section)'}`));

  // Store publish hash for summary tracking
  if (usedSummary) {
    ws ??= new WorkspaceManager(process.cwd());
    const bundleState = await ws.loadBundleState();
    if (bundleState) {
      const summaryContent = await fs.readFile(workspacePath(DEFAULT_SUMMARY_FILE), 'utf-8');
      const hash = computeContentHash(summaryContent);
      await ws.updateOutputPublishState('summary', hash, bundleState.target.diffRefs.headSha);
    }
  }

  return 1;
}

/**
 * GitHub-specific: load, validate, and submit findings + review note as a single PR review batch.
 * Clears successfully published outputs. Returns the number of findings published.
 */
async function publishFindingsAndReviewBatch(reviewContent: string): Promise<number> {
  const { findings, resolvedPath } = await loadAndValidateFindings(DEFAULT_FINDINGS_FILE, { allowMissing: true });
  if (findings.length === 0) return 0;

  const annotated = annotateFindingBodies(findings);

  const orchestrator = await createOrchestrator();
  const defaultRepo = await getRepoFromGit();
  await orchestrator.publishReviewBatch(annotated, reviewContent, defaultRepo);

  console.log(chalk.green(`  ✓ ${findings.length} finding(s) published as PR review`));
  if (reviewContent.trim()) {
    console.log(chalk.green('  ✓ Review body included in PR review'));
  }

  await saveFindings(resolvedPath, [], { deleteWhenEmpty: true });

  const ws = new WorkspaceManager(process.cwd());
  await trackFindingActions(ws, annotated);

  if (reviewContent.trim()) {
    await clearDefaultReviewOutput();
  }

  return findings.length;
}

async function publishReviewCmd(opts: { from?: string; repo?: string; allowEmpty?: boolean }): Promise<number> {
  const defaultNote = opts.from ? null : await loadDefaultReviewNote();
  const filePath = opts.from ?? defaultNote?.filePath ?? DEFAULT_NOTE_FILE;
  let content: string;
  if (defaultNote) {
    content = defaultNote.content;
  } else {
    try {
      content = await fs.readFile(workspacePath(filePath), 'utf-8');
    } catch {
      throw new Error(`No review note found at ${filePath}.`);
    }
  }
  if (opts.allowEmpty && !content.trim()) {
    console.log(chalk.dim('No review note published'));
    return 0;
  }
  requirePublishableContent(content, filePath);

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? (await getRepoFromGit());

  const result = await orchestrator.publishReview(content, defaultRepo);
  if (result.created) {
    console.log(chalk.green('Review note published'));
  } else {
    console.log(chalk.dim('No review note published'));
  }

  const isDefaultReviewFile = !opts.from;
  if (result.created && isDefaultReviewFile) {
    await clearDefaultReviewOutput();
  }

  return result.created ? 1 : 0;
}

async function publishCheckpointCmd(opts: { repo?: string }): Promise<void> {
  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? (await getRepoFromGit());

  await orchestrator.publishCheckpoint(defaultRepo);
  console.log(chalk.green('✓ Checkpoint recorded'));
}

function isNoReviewNoteToPublishError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.message.includes('No review note found') || / is empty(?:; nothing to publish)?$/.test(err.message);
}

type BundleFreshness = 'current' | 'stale';

interface GuidedPublishDependencies {
  terminal?: PublishTerminal;
  loadMaterial?: typeof loadPublishMaterial;
  createOrchestrator?: typeof createOrchestrator;
  getRepository?: typeof getRepoFromGit;
  runSelector?: typeof runGuidedPublish;
  runStalePrompt?: typeof runStalePublishPrompt;
}

function requireInteractiveTerminal(terminal: Pick<PublishTerminal, 'interactive'>): void {
  if (terminal.interactive) return;
  throw new Error(
    'Interactive publishing requires a terminal.\n' +
      'Use `revpack publish all` or a specific `revpack publish <command>` in scripts.',
  );
}

function requirePublishRepository(repository: string | undefined): string {
  if (repository) return repository;
  throw new Error('Could not determine the repository for publishing.');
}

async function determineBundleFreshness(
  orchestrator: Pick<ReviewOrchestrator, 'open'>,
  repository: string,
  preparedHeadSha: string,
): Promise<BundleFreshness> {
  let currentHeadSha: string;
  try {
    const target = await orchestrator.open(undefined, repository);
    currentHeadSha = target.diffRefs.headSha;
  } catch (error) {
    throw new Error(
      'Could not determine whether the active review bundle is current. Nothing was published.\n' +
        (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
  if (!currentHeadSha) {
    throw new Error('Could not determine the current review-target head. Nothing was published.');
  }
  return sameCommitSha(currentHeadSha, preparedHeadSha) ? 'current' : 'stale';
}

function toGuidedPublishModel(material: PublishMaterial): GuidedPublishModel {
  return {
    provider: material.bundleState.target.provider,
    findings: material.findings.map(({ index, value }) => ({ index, value })),
    replies: material.replies.map(({ index, value }) => ({ index, value })),
    replyContexts: material.replyContexts,
    summary: { state: material.summary.state, content: material.summary.content },
    note: { content: material.note.content },
    checkpoint: {
      state: material.checkpointState,
      targetHeadSha: material.bundleState.target.diffRefs.headSha,
    },
  };
}

function hasSelectablePublishMaterial(material: PublishMaterial): boolean {
  return (
    material.findings.length > 0 ||
    material.replies.length > 0 ||
    material.summary.state === 'pending' ||
    material.summary.state === 'modified since publish' ||
    material.note.state === 'pending' ||
    material.checkpointState !== 'current'
  );
}

const PUBLISH_SECTION_LABELS: Record<Extract<PublishPlanProgress, { type: 'section' }>['section'], string> = {
  replies: 'Replies',
  findings: 'Findings',
  summary: 'Summary',
  note: 'Review note',
  checkpoint: 'Checkpoint',
  refresh: 'Refresh',
};

function printPublishProgress(event: PublishPlanProgress): void {
  if (event.type === 'section') {
    console.log('');
    console.log(chalk.bold(`─── ${PUBLISH_SECTION_LABELS[event.section]} ───`));
    return;
  }
  if (event.type === 'success') {
    console.log(chalk.green(`  ✓ ${event.label}`));
    return;
  }
  if (event.type === 'failure') {
    console.error(chalk.red(`  ✗ ${event.label}: ${event.error}`));
    return;
  }
  console.log(chalk.dim(`  ${event.message}`));
}

function reportPublishResult(result: PublishExecutionResult): void {
  const remainingDrafts = result.remainingReplies + result.remainingFindings;
  const successfulLabels = result.successes.map((item) => item.label);
  if (result.failures.length > 0) {
    const failureSummary =
      result.checkpoint === 'failed'
        ? 'The checkpoint failed and the review bundle was not refreshed.'
        : result.checkpoint === 'blocked'
          ? 'Publishing stopped before the checkpoint and refresh because selected review material failed.'
          : 'Publishing stopped before refresh because selected review material failed.';
    console.error('');
    console.error(
      chalk.yellow(
        `${failureSummary}\n` +
          'Provider actions may already have succeeded. Review the target before retrying to avoid duplicate comments.',
      ),
    );
    console.error(chalk.dim(`Succeeded: ${successfulLabels.length > 0 ? successfulLabels.join(', ') : 'none'}`));
    console.error(chalk.dim(`Failed: ${result.failures.map((failure) => failure.label).join(', ')}`));
    console.error(
      chalk.dim(`Remaining drafts: ${result.remainingFindings} finding(s), ${result.remainingReplies} reply/replies.`),
    );
    throw new Error(
      `${result.failures.length} selected publish action(s) failed: ` +
        `${result.failures.map((failure) => `${failure.label}: ${failure.error}`).join('; ')}. ` +
        'Remaining drafts are reported above.',
    );
  }

  console.log('');
  if (result.successes.length === 0) {
    console.log(chalk.dim('No pending outputs were selected for publishing.'));
  } else {
    console.log(chalk.green(`✓ ${result.successes.length} item(s) published: ${successfulLabels.join(', ')}`));
  }
  if (remainingDrafts > 0) {
    console.log(
      chalk.yellow(
        `${remainingDrafts} draft(s) remain (${result.remainingFindings} finding(s), ${result.remainingReplies} reply/replies).`,
      ),
    );
  }
  if (result.refresh === 'failed') {
    console.error(
      chalk.yellow(
        `Publishing succeeded, but the review bundle could not be refreshed: ${result.refreshError ?? 'unknown error'}`,
      ),
    );
  }
}

async function executePreparedPublishPlan(
  material: PublishMaterial,
  selection: PublishSelection,
  orchestrator: ReviewOrchestrator,
  repository: string,
  refresh: boolean,
): Promise<PublishExecutionResult> {
  const result = await executePublishPlan({
    material,
    selection,
    orchestrator,
    repository,
    refresh,
    onProgress: printPublishProgress,
  });
  reportPublishResult(result);
  return result;
}

async function guidedPublish(
  opts: { refresh?: boolean } = {},
  dependencies: GuidedPublishDependencies = {},
): Promise<void> {
  const terminal = dependencies.terminal ?? createNodePublishTerminal();
  requireInteractiveTerminal(terminal);

  const loadMaterial = dependencies.loadMaterial ?? loadPublishMaterial;
  const createPublishOrchestrator = dependencies.createOrchestrator ?? createOrchestrator;
  const getRepository = dependencies.getRepository ?? getRepoFromGit;
  const runSelector = dependencies.runSelector ?? runGuidedPublish;
  const runStalePrompt = dependencies.runStalePrompt ?? runStalePublishPrompt;

  let material = await loadMaterial(process.cwd());
  const orchestrator = await createPublishOrchestrator();
  const repository = requirePublishRepository((await getRepository()) ?? material.bundleState.target.repository);

  const refreshStaleBundle = async (): Promise<boolean> => {
    const staleChoice = await runStalePrompt(terminal);
    if (staleChoice === 'cancel') {
      console.log(chalk.dim('Publishing cancelled. No drafts were changed.'));
      return false;
    }
    try {
      await orchestrator.prepare(undefined, repository, { preservePendingOutputs: true });
    } catch (error) {
      throw new Error(
        'Could not refresh the stale review bundle. Pending drafts were left unchanged.\n' +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
    material = await loadMaterial(process.cwd());
    return true;
  };

  while (true) {
    const freshness = await determineBundleFreshness(
      orchestrator,
      repository,
      material.bundleState.target.diffRefs.headSha,
    );
    if (freshness === 'stale') {
      if (!(await refreshStaleBundle())) return;
      continue;
    }

    if (!hasSelectablePublishMaterial(material)) {
      console.log(chalk.dim('No review material is pending; the checkpoint is current.'));
      return;
    }

    const selection = await runSelector(toGuidedPublishModel(material), terminal);
    if (!selection) {
      console.log(chalk.dim('Publishing cancelled. No drafts were changed.'));
      return;
    }

    const confirmedFreshness = await determineBundleFreshness(
      orchestrator,
      repository,
      material.bundleState.target.diffRefs.headSha,
    );
    if (confirmedFreshness === 'stale') {
      if (!(await refreshStaleBundle())) return;
      continue;
    }

    await executePreparedPublishPlan(material, selection, orchestrator, repository, opts.refresh !== false);
    return;
  }
}

async function publishAllPending(opts: { refresh?: boolean } = {}): Promise<void> {
  const material = await loadPublishMaterial(process.cwd());
  const orchestrator = await createOrchestrator();
  const repository = requirePublishRepository((await getRepoFromGit()) ?? material.bundleState.target.repository);
  await executePreparedPublishPlan(
    material,
    selectAllPublishMaterial(material),
    orchestrator,
    repository,
    opts.refresh !== false,
  );
}

export const __testing = {
  findReplyEntryIndex,
  normalizeThreadRef,
  isNoReviewNoteToPublishError,
  requireInteractiveTerminal,
  determineBundleFreshness,
  toGuidedPublishModel,
  hasSelectablePublishMaterial,
  reportPublishResult,
  executePreparedPublishPlan,
  publishReplies,
  publishFindings,
  publishDescription,
  publishFindingsAndReviewBatch,
  publishReviewCmd,
  requirePublishableContent,
  publishAllPending,
  guidedPublish,
  autoRefresh,
};

// ─── Auto-refresh helper ─────────────────────────────────

async function autoRefresh(): Promise<void> {
  try {
    const orchestrator = await createOrchestrator();
    const defaultRepo = await getRepoFromGit();
    await orchestrator.prepare(undefined, defaultRepo, { preservePendingOutputs: true });
    console.log(chalk.dim('Bundle refreshed.'));
  } catch {
    console.log(chalk.dim('(could not auto-refresh bundle)'));
  }
}

// ─── Command registration ────────────────────────────────

export function registerPublishCommand(program: Command): void {
  const publish = new Command('publish')
    .description('Preview and select pending outputs to publish to the PR/MR')
    .option('--no-refresh', 'Skip auto-refresh after publishing');

  // ── publish (no subcommand) → guided human publish flow ───
  publish.action(async (_opts: Record<string, never>, cmd: Command) => {
    try {
      const parentOpts = cmd.opts<{ refresh?: boolean }>();
      await guidedPublish({ refresh: parentOpts?.refresh });
    } catch (err) {
      handleError(err);
    }
  });

  // ── publish all ───────────────────────────────────────────
  publish
    .command('all')
    .description('Publish all pending outputs')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts<{ refresh?: boolean }>();
        await publishAllPending({ refresh: parentOpts?.refresh });
      } catch (err) {
        handleError(err);
      }
    });

  // ── publish replies [thread] ───────────────────────────────
  publish
    .command('replies [thread]')
    .description('Publish replies from replies.json')
    .option('--from <file>', `Replies JSON file (default: ${DEFAULT_REPLIES_FILE})`)
    .option('--body <text>', 'Inline reply body (single thread only)')
    .option('--resolve', 'Resolve the thread(s) after replying')
    .action(
      async (thread: string | undefined, opts: { from?: string; body?: string; resolve?: boolean }, cmd: Command) => {
        try {
          const parentOpts = cmd.parent?.opts();
          await publishReplies({ thread, ...opts });
          if (parentOpts?.refresh !== false) {
            await autoRefresh();
          }
        } catch (err) {
          handleError(err);
        }
      },
    );

  // ── publish findings ───────────────────────────────────────
  publish
    .command('findings')
    .description('Publish agent-generated findings as new threads')
    .option('--from <file>', `Findings JSON file (default: ${DEFAULT_FINDINGS_FILE})`)
    .option('--dry-run', 'Show what would be published without creating threads')
    .action(async (opts: { from?: string; dryRun?: boolean }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts();
        await publishFindings(opts);
        if (!opts.dryRun && parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── publish summary ────────────────────────────────────────
  function addSummaryPublishCommand(commandName: string, opts?: { hidden?: boolean }): void {
    publish
      .command(commandName, opts)
      .description('Update the PR/MR summary section in the description')
      .option('--from <file>', 'Read content from a file')
      .option('--replace', 'Replace entire description')
      .option('--repo <repo>', 'Repository slug')
      .action(async (opts: PublishSummaryOptions, cmd: Command) => {
        try {
          const parentOpts = cmd.parent?.opts();
          await publishDescription(opts);
          if (parentOpts?.refresh !== false) {
            await autoRefresh();
          }
        } catch (err) {
          handleError(err);
        }
      });
  }

  addSummaryPublishCommand('summary');
  addSummaryPublishCommand('description', { hidden: true });

  // ── publish review ──────────────────────────────────────────
  function addReviewPublishCommand(commandName: string, opts?: { hidden?: boolean }): void {
    publish
      .command(commandName, opts)
      .description('Publish note.md as a review note')
      .option('--from <file>', `Review note file (default: ${DEFAULT_NOTE_FILE})`)
      .option('--repo <repo>', 'Repository slug')
      .action(async (opts: { from?: string; repo?: string }, cmd: Command) => {
        try {
          const parentOpts = cmd.parent?.opts();
          await publishReviewCmd(opts);
          if (parentOpts?.refresh !== false) {
            await autoRefresh();
          }
        } catch (err) {
          handleError(err);
        }
      });
  }

  addReviewPublishCommand('note');
  addReviewPublishCommand('review', { hidden: true });

  publish
    .command('checkpoint')
    .description('Record the review checkpoint')
    .option('--repo <repo>', 'Repository slug')
    .action(async (opts: { repo?: string }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts();
        await publishCheckpointCmd(opts);
        if (parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  program.addCommand(publish);
}
