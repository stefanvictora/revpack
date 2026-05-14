import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import type { NewFinding } from '../../core/types.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { parsePatch } from '../../workspace/patch-parser.js';
import { validateFindings, formatValidationErrors } from '../../workspace/finding-validator.js';
import { createOrchestrator, getRepoFromGit, handleError } from '../helpers.js';
import { computeContentHash } from '../../workspace/thread-digest.js';
import { mergeWithMarkers, MARKER_START, MARKER_END } from '../../workspace/description-summary.js';
import { buildFindingHeader } from '../../workspace/finding-formatter.js';

export { mergeWithMarkers, MARKER_START, MARKER_END };

const DEFAULT_REPLIES_FILE = '.revpack/outputs/replies.json';
const DEFAULT_FINDINGS_FILE = '.revpack/outputs/new-findings.json';
const DEFAULT_REVIEW_FILE = '.revpack/outputs/review.md';
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

async function loadRepliesJson(filePath: string): Promise<ReplyEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as ReplyEntry[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of { threadId, body, resolve? } objects`);
  }
}

async function saveRepliesJson(filePath: string, entries: ReplyEntry[]): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

async function loadNewFindings(filePath: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as unknown[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of finding objects`);
  }
}

async function saveFindings(filePath: string, entries: NewFinding[]): Promise<void> {
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

  if (opts.thread) {
    // Single thread mode
    let body: string;
    let shouldResolve = opts.resolve ?? false;
    let entries: ReplyEntry[] | undefined;
    let matchedIdx = -1;

    if (opts.body) {
      body = opts.body;
    } else {
      entries = await loadRepliesJson(repliesFile);
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
      await saveRepliesJson(repliesFile, entries);
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
  const entries = await loadRepliesJson(repliesFile);
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
        await saveRepliesJson(repliesFile, remaining);
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
              `    resolve failed: ${err instanceof Error ? err.message : String(err)} (reply will not be retried)`,
            ),
          );
        }
      }
    } catch (err) {
      console.error(chalk.red(`  ✗ ${entry.threadId}: ${err instanceof Error ? err.message : String(err)}`));
    }
  }
  await saveRepliesJson(repliesFile, remaining);
  if (posted > 0) console.log(chalk.green(`${posted} replies published`));
  return posted;
}

async function loadAndValidateFindings(filePath: string): Promise<{ findings: NewFinding[]; resolvedPath: string }> {
  const resolvedPath = workspacePath(filePath);
  const rawFindings = await loadNewFindings(resolvedPath);
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

async function publishFindings(opts: { from?: string; dryRun?: boolean; noRefresh?: boolean }): Promise<number> {
  const filePath = opts.from ?? DEFAULT_FINDINGS_FILE;
  const { findings, resolvedPath } = await loadAndValidateFindings(filePath);
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
  await saveFindings(resolvedPath, remaining);
  if (published > 0) console.log(chalk.green(`${published}/${findings.length} findings published`));
  return published;
}

async function publishDescription(opts: {
  from?: string;
  fromSummary?: boolean;
  replace?: boolean;
  repo?: string;
}): Promise<number> {
  let content: string;
  if (opts.from) {
    content = await fs.readFile(workspacePath(opts.from), 'utf-8');
  } else if (opts.fromSummary) {
    try {
      content = await fs.readFile(workspacePath(DEFAULT_SUMMARY_FILE), 'utf-8');
    } catch {
      console.error(chalk.red('No summary found. Run `revpack prepare` first.'));
      process.exit(1);
    }
  } else {
    console.error(chalk.red('Provide --from <file> or --from-summary'));
    process.exit(1);
  }
  requirePublishableContent(content, opts.fromSummary ? DEFAULT_SUMMARY_FILE : (opts.from ?? 'description content'));

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? (await getRepoFromGit());

  let body: string;
  if (opts.replace) {
    body = content!;
  } else {
    const target = await orchestrator.open(undefined, defaultRepo);
    body = mergeWithMarkers(target.description, content!);
  }

  await orchestrator.updateDescription(undefined, body, defaultRepo);
  console.log(chalk.green(`✓ Description updated${opts.replace ? '' : ' (marked section)'}`));

  // Store publish hash for summary tracking
  if (opts.fromSummary) {
    const ws = new WorkspaceManager(process.cwd());
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
 * GitHub-specific: load, validate, and submit findings + review.md as a single PR review batch.
 * Advances the checkpoint. Returns the number of findings published.
 */
async function publishFindingsAndReviewBatch(reviewContent: string): Promise<number> {
  const { findings, resolvedPath } = await loadAndValidateFindings(DEFAULT_FINDINGS_FILE);
  if (findings.length === 0) return 0;

  const annotated = annotateFindingBodies(findings);

  const orchestrator = await createOrchestrator();
  const defaultRepo = await getRepoFromGit();
  await orchestrator.publishReviewBatch(annotated, reviewContent, defaultRepo);

  console.log(chalk.green(`  ✓ ${findings.length} finding(s) published as PR review`));
  if (reviewContent.trim()) {
    console.log(chalk.green('  ✓ Review body included in PR review'));
  }

  await saveFindings(resolvedPath, []);

  const ws = new WorkspaceManager(process.cwd());
  await trackFindingActions(ws, annotated);

  if (reviewContent.trim()) {
    const bundleState = await ws.loadBundleState();
    if (bundleState) {
      const hash = computeContentHash(reviewContent);
      await ws.updateOutputPublishState('review', hash, bundleState.target.diffRefs.headSha);
    }
  }

  return findings.length;
}

async function publishReviewCmd(opts: { from?: string; repo?: string }): Promise<number> {
  const filePath = opts.from ?? DEFAULT_REVIEW_FILE;
  let content: string;
  try {
    content = await fs.readFile(workspacePath(filePath), 'utf-8');
  } catch {
    content = '';
  }

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? (await getRepoFromGit());

  const result = await orchestrator.publishReview(content, defaultRepo);
  if (result.created) {
    console.log(chalk.green('✓ Review published and checkpoint advanced'));
  } else {
    console.log(chalk.green('✓ Checkpoint advanced (no review body to publish)'));
  }

  // Store publish hash for review tracking
  if (content.trim()) {
    const ws = new WorkspaceManager(process.cwd());
    const bundleState = await ws.loadBundleState();
    if (bundleState) {
      const hash = computeContentHash(content);
      await ws.updateOutputPublishState('review', hash, bundleState.target.diffRefs.headSha, result.noteId);
    }
  }

  return 1;
}

function warnPartialSuccess(occurred: boolean): void {
  if (!occurred) return;
  console.error(
    chalk.yellow(
      'Publishing failed after one or more provider actions may already have succeeded.\n' +
        'The checkpoint was not advanced and pending output files were not cleared.\n' +
        'Review the PR/MR before retrying to avoid duplicate comments.',
    ),
  );
}

export const __testing = {
  findReplyEntryIndex,
  normalizeThreadRef,
  publishReplies,
  publishDescription,
  requirePublishableContent,
};

// ─── Auto-refresh helper ─────────────────────────────────

async function autoRefresh(): Promise<void> {
  try {
    const orchestrator = await createOrchestrator();
    const defaultRepo = await getRepoFromGit();
    await orchestrator.prepare(undefined, defaultRepo);
    console.log(chalk.dim('Bundle refreshed.'));
  } catch {
    console.log(chalk.dim('(could not auto-refresh bundle)'));
  }
}

// ─── Command registration ────────────────────────────────

export function registerPublishCommand(program: Command): void {
  const publish = new Command('publish')
    .description('Publish pending outputs to the MR/PR')
    .option('--no-refresh', 'Skip auto-refresh after publishing');

  // ── publish (no subcommand) → tell user to be explicit ───
  publish.action(() => {
    console.log(chalk.yellow('Please specify what to publish:'));
    console.log('');
    console.log('  revpack publish all           Publish everything pending');
    console.log('  revpack publish findings      Publish findings only');
    console.log('  revpack publish replies       Publish replies only');
    console.log('  revpack publish description   Update MR description');
    console.log('  revpack publish review        Publish review.md if non-empty and advance checkpoint');
    process.exit(1);
  });

  // ── publish all ───────────────────────────────────────────
  publish
    .command('all')
    .description('Publish all pending outputs')
    .action(async (_opts: Record<string, never>, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts();
        let total = 0;
        let partialSuccess = false;

        // Determine provider for flow branching
        const ws = new WorkspaceManager(process.cwd());
        const bundleState = await ws.loadBundleState();
        const isGitHub = bundleState?.target.provider === 'github';

        // ── 1. Replies ───────────────────────────────────────
        console.log(chalk.bold('─── Replies ───'));
        const replyCount = await publishReplies({ noRefresh: true });
        if (replyCount === 0) console.log(chalk.dim('  (none pending)'));
        total += replyCount;
        if (replyCount > 0) partialSuccess = true;

        // ── 2. Findings ──────────────────────────────────────
        console.log('');
        console.log(chalk.bold('─── Findings ───'));
        let batchCount = 0;
        if (isGitHub) {
          // GitHub: findings + review.md submitted as a single atomic PR review batch
          let reviewContent = '';
          try {
            reviewContent = await fs.readFile(workspacePath(DEFAULT_REVIEW_FILE), 'utf-8');
          } catch {
            /* review.md absent is fine */
          }
          try {
            batchCount = await publishFindingsAndReviewBatch(reviewContent);
            if (batchCount === 0) console.log(chalk.dim('  (none pending)'));
            total += batchCount;
            if (batchCount > 0) partialSuccess = true;
          } catch (err) {
            warnPartialSuccess(partialSuccess);
            throw err;
          }
        } else {
          // GitLab (or unknown): findings posted as individual discussions
          const findingCount = await publishFindings({ noRefresh: true });
          if (findingCount === 0) console.log(chalk.dim('  (none pending)'));
          total += findingCount;
          if (findingCount > 0) partialSuccess = true;
        }

        // ── 3. Description ───────────────────────────────────
        console.log('');
        console.log(chalk.bold('─── Description ───'));
        try {
          total += await publishDescription({ fromSummary: true });
          partialSuccess = true;
        } catch {
          console.log(chalk.dim('  (no summary to publish)'));
        }

        // ── 4. Review / Checkpoint ────────────────────────────
        // GitHub batch already advanced the checkpoint when findings were submitted.
        // For all other cases (GitLab, or GitHub with no findings), run the normal flow.
        console.log('');
        console.log(chalk.bold('─── Review & Checkpoint ───'));
        if (batchCount > 0) {
          console.log(chalk.green('✓ Checkpoint advanced (state in description)'));
          total += 1;
        } else {
          try {
            total += await publishReviewCmd({});
          } catch (err) {
            warnPartialSuccess(partialSuccess);
            throw err;
          }
        }

        // ── Summary ──────────────────────────────────────────
        console.log('');
        if (total === 0) {
          console.log(chalk.dim('Nothing to publish.'));
        } else {
          console.log(chalk.green(`✓ ${total} item(s) published`));
        }

        if (parentOpts?.refresh !== false && total > 0) {
          await autoRefresh();
        }
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

  // ── publish description ────────────────────────────────────
  publish
    .command('description')
    .description('Update the MR/PR description with a revpack section')
    .option('--from <file>', 'Read content from a file')
    .option('--from-summary', 'Use the generated summary.md')
    .option('--replace', 'Replace entire description')
    .option('--repo <repo>', 'Repository slug')
    .action(async (opts: { from?: string; fromSummary?: boolean; replace?: boolean; repo?: string }, cmd: Command) => {
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

  // ── publish review ──────────────────────────────────────────
  publish
    .command('review')
    .description('Publish review.md if non-empty and advance checkpoint')
    .option('--from <file>', `Review file (default: ${DEFAULT_REVIEW_FILE})`)
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

  program.addCommand(publish);
}
