import { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import type { NewFinding } from '../../core/types.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { parsePatch } from '../../workspace/patch-parser.js';
import { validateFindings, formatValidationErrors } from '../../workspace/finding-validator.js';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

// ─── Marker-based description merge ─────────────────────

export const MARKER_START = '<!-- review-assist:start -->';
export const MARKER_END   = '<!-- review-assist:end -->';

/**
 * Merge new content into the description using HTML comment markers.
 * If markers exist, replaces the content between them.
 * If no markers exist, appends a new marked section.
 */
export function mergeWithMarkers(existing: string, newContent: string): string {
  const markedSection = `${MARKER_START}\n${newContent.trim()}\n${MARKER_END}`;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx   = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return existing.slice(0, startIdx) + markedSection + existing.slice(endIdx + MARKER_END.length);
  }

  const separator = existing.trim() ? '\n\n---\n\n' : '';
  return existing.trimEnd() + separator + markedSection;
}

const DEFAULT_REPLIES_FILE = '.review-assist/outputs/replies.json';
const DEFAULT_FINDINGS_FILE = '.review-assist/outputs/new-findings.json';
const DEFAULT_REVIEW_NOTES_FILE = '.review-assist/outputs/review-notes.md';

// ─── JSON helpers ────────────────────────────────────────

interface ReplyEntry {
  threadId: string;
  body: string;
  resolve?: boolean;
}

async function loadRepliesJson(filePath: string): Promise<ReplyEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
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
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as unknown[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of finding objects`);
  }
}

async function saveFindings(filePath: string, entries: NewFinding[]): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

// ─── Severity → emoji mapping ────────────────────────────

const SEVERITY_ICON: Record<string, string> = {
  blocker: '🔴',
  high: '🔴',
  medium: '🟡',
  low: '🟢',
  info: '🟢',
  nit: '🟢',
};

function buildFindingHeader(severity: string, category: string): string {
  const icon = SEVERITY_ICON[severity] ?? '🟡';
  const sevLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `_${icon} ${sevLabel}_ | _${category}_\n\n`;
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
  const defaultRepo = await getDefaultRepo();
  const repliesFile = opts.from ?? DEFAULT_REPLIES_FILE;

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
      matchedIdx = entries.findIndex(
        (e) => e.threadId === opts.thread || e.threadId === resolved,
      );
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
    if (shouldResolve) {
      await orchestrator.resolveThread(undefined, opts.thread, defaultRepo);
      console.log(chalk.dim('  thread resolved'));
    }

    const ws = new WorkspaceManager(process.cwd());
    if (entries && matchedIdx >= 0) {
      entries.splice(matchedIdx, 1);
      await saveRepliesJson(repliesFile, entries);
    }
    await ws.appendPublishedAction({
      type: 'reply',
      threadId: opts.thread,
      detail: body.split('\n')[0].slice(0, 80),
      publishedAt: new Date().toISOString(),
    });
    if (shouldResolve) {
      await ws.appendPublishedAction({
        type: 'resolve',
        threadId: opts.thread,
        detail: 'Thread resolved',
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
  const remaining: ReplyEntry[] = [];
  for (const entry of entries) {
    try {
      await orchestrator.publishReply(undefined, entry.threadId, entry.body, defaultRepo);
      console.log(chalk.green(`  ✓ ${entry.threadId}`));
      posted++;
      await ws.appendPublishedAction({
        type: 'reply',
        threadId: entry.threadId,
        detail: entry.body.split('\n')[0].slice(0, 80),
        publishedAt: new Date().toISOString(),
      });
      if (entry.resolve || opts.resolve) {
        await orchestrator.resolveThread(undefined, entry.threadId, defaultRepo);
        console.log(chalk.dim('    resolved'));
        await ws.appendPublishedAction({
          type: 'resolve',
          threadId: entry.threadId,
          detail: 'Thread resolved',
          publishedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(chalk.red(`  ✗ ${entry.threadId}: ${err instanceof Error ? err.message : String(err)}`));
      remaining.push(entry);
    }
  }
  await saveRepliesJson(repliesFile, remaining);
  if (posted > 0) console.log(chalk.green(`${posted} replies published`));
  return posted;
}

async function publishFindings(opts: {
  from?: string;
  dryRun?: boolean;
  noRefresh?: boolean;
}): Promise<number> {
  const filePath = opts.from ?? DEFAULT_FINDINGS_FILE;
  const rawFindings = await loadNewFindings(filePath);
  if (rawFindings.length === 0) return 0;

  // Load line map for validation
  const patchPath = '.review-assist/diffs/latest.patch';
  let patchContent: string;
  try {
    patchContent = await fs.readFile(patchPath, 'utf-8');
  } catch {
    throw new Error(
      `Cannot validate findings: ${patchPath} not found.\n` +
      `Run \`review-assist review\` first to generate the diff bundle.`,
    );
  }

  const lineMap = parsePatch(patchContent);
  const { valid: findings, errors } = validateFindings(rawFindings, lineMap);

  if (errors.length > 0) {
    console.error(chalk.red(`\n${errors.length} finding(s) failed validation:\n`));
    console.error(formatValidationErrors(errors));
    console.error('');
    throw new Error(
      `${errors.length} invalid finding(s) in ${filePath}. Fix the positions and retry.\n` +
      `The output file has not been modified.`,
    );
  }

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
  const defaultRepo = await getDefaultRepo();
  const ws = new WorkspaceManager(process.cwd());

  let published = 0;
  const remaining: NewFinding[] = [];
  for (const finding of findings) {
    try {
      const body = buildFindingHeader(finding.severity, finding.category) + finding.body;
      const createdThreadId = await orchestrator.publishFinding(
        { ...finding, body },
        defaultRepo,
      );
      const displayPath = finding.newPath || finding.oldPath;
      console.log(chalk.green(`  \u2713 ${displayPath}:${finding.newLine ?? finding.oldLine} (${finding.severity})`));
      published++;
      await ws.appendPublishedAction({
        type: 'finding',
        threadId: createdThreadId,
        filePath: displayPath,
        line: finding.newLine ?? finding.oldLine,
        detail: `${finding.severity} ${finding.category}: ${finding.body.split('\n')[0].slice(0, 60)}`,
        publishedAt: new Date().toISOString(),
        createdThreadId,
      });
    } catch (err) {
      const displayPath = finding.newPath || finding.oldPath;
      console.error(chalk.red(`  \u2717 ${displayPath}:${finding.newLine ?? finding.oldLine}: ${err instanceof Error ? err.message : String(err)}`));
      remaining.push(finding);
    }
  }
  await saveFindings(filePath, remaining);
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
    content = await fs.readFile(opts.from, 'utf-8');
  } else if (opts.fromSummary) {
    try {
      content = await fs.readFile('.review-assist/outputs/summary.md', 'utf-8');
    } catch {
      console.error(chalk.red('No summary found. Run `review-assist review` first.'));
      process.exit(1);
    }
  } else {
    console.error(chalk.red('Provide --from <file> or --from-summary'));
    process.exit(1);
  }

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? await getDefaultRepo();

  let body: string;
  if (opts.replace) {
    body = content!;
  } else {
    const target = await orchestrator.open(undefined, defaultRepo);
    body = mergeWithMarkers(target.description, content!);
  }

  await orchestrator.updateDescription(undefined, body, defaultRepo);
  console.log(chalk.green(`✓ Description updated${opts.replace ? '' : ' (marked section)'}`));
  return 1;
}

async function publishNotes(opts: {
  from?: string;
  repo?: string;
}): Promise<number> {
  const filePath = opts.from ?? DEFAULT_REVIEW_NOTES_FILE;
  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf-8');
  } catch {
    return 0;
  }

  if (!content.trim()) return 0;

  const orchestrator = await createOrchestrator();
  const defaultRepo = opts.repo ?? await getDefaultRepo();

  const result = await orchestrator.syncReviewComment(content, defaultRepo);
  if (result.created) {
    console.log(chalk.green('✓ Review comment created on the MR'));
  } else {
    console.log(chalk.green('✓ Review comment updated on the MR'));
  }
  return 1;
}

// ─── Auto-refresh helper ─────────────────────────────────

async function autoRefresh(): Promise<void> {
  try {
    const orchestrator = await createOrchestrator();
    const defaultRepo = await getDefaultRepo();
    await orchestrator.review(undefined, defaultRepo);
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

  // ── publish (no subcommand) → publish everything pending ───
  publish.action(async (opts: { refresh?: boolean }) => {
    try {
      let total = 0;
      const replyCount = await publishReplies({ noRefresh: true });
      total += replyCount;
      const findingCount = await publishFindings({ noRefresh: true });
      total += findingCount;

      // Notes and description are optional — try but don't fail
      try { total += await publishNotes({}); } catch { /* no notes */ }
      try { total += await publishDescription({ fromSummary: true }); } catch { /* no description */ }

      if (total === 0) {
        console.log(chalk.dim('Nothing to publish.'));
      } else {
        console.log('');
        console.log(chalk.green(`✓ ${total} item(s) published`));
      }

      if (opts.refresh !== false && total > 0) {
        await autoRefresh();
      }
    } catch (err) {
      handleError(err);
    }
  });

  // ── publish replies [thread] ───────────────────────────────
  publish.command('replies [thread]')
    .description('Publish replies from replies.json')
    .option('--from <file>', `Replies JSON file (default: ${DEFAULT_REPLIES_FILE})`)
    .option('--body <text>', 'Inline reply body (single thread only)')
    .option('--resolve', 'Resolve the thread(s) after replying')
    .action(async (thread: string | undefined, opts: { from?: string; body?: string; resolve?: boolean }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts() as { refresh?: boolean } | undefined;
        await publishReplies({ thread, ...opts });
        if (parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── publish findings ───────────────────────────────────────
  publish.command('findings')
    .description('Publish agent-generated findings as new threads')
    .option('--from <file>', `Findings JSON file (default: ${DEFAULT_FINDINGS_FILE})`)
    .option('--dry-run', 'Show what would be published without creating threads')
    .action(async (opts: { from?: string; dryRun?: boolean }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts() as { refresh?: boolean } | undefined;
        await publishFindings(opts);
        if (!opts.dryRun && parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── publish description ────────────────────────────────────
  publish.command('description')
    .description('Update the MR/PR description with a review-assist section')
    .option('--from <file>', 'Read content from a file')
    .option('--from-summary', 'Use the generated summary.md')
    .option('--replace', 'Replace entire description')
    .option('--repo <repo>', 'Repository slug')
    .action(async (opts: { from?: string; fromSummary?: boolean; replace?: boolean; repo?: string }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts() as { refresh?: boolean } | undefined;
        await publishDescription(opts);
        if (parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  // ── publish notes ──────────────────────────────────────────
  publish.command('notes')
    .description('Create or update the review comment on the MR/PR')
    .option('--from <file>', `Review notes file (default: ${DEFAULT_REVIEW_NOTES_FILE})`)
    .option('--repo <repo>', 'Repository slug')
    .action(async (opts: { from?: string; repo?: string }, cmd: Command) => {
      try {
        const parentOpts = cmd.parent?.opts() as { refresh?: boolean } | undefined;
        await publishNotes(opts);
        if (parentOpts?.refresh !== false) {
          await autoRefresh();
        }
      } catch (err) {
        handleError(err);
      }
    });

  program.addCommand(publish);
}
