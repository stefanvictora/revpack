import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ReviewTarget,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
  WorkspaceBundle,
  Session,
  PublishedAction,
} from '../core/types.js';
import { WorkspaceError } from '../core/errors.js';

/**
 * Map from thread SHA → stable T-NNN short ID.
 * Derived from position in the provider's all-threads list
 * (which is ordered by creation date and never reorders).
 */
export type ThreadIndex = Map<string, string>;

export class WorkspaceManager {
  private readonly baseDir: string;

  constructor(workingDir: string, bundleDirName = '.review-assist') {
    this.baseDir = path.join(workingDir, bundleDirName);
  }

  get bundlePath(): string {
    return this.baseDir;
  }

  // ─── Bundle creation ────────────────────────────────────

  /**
   * Build a ThreadIndex from the provider's full thread list.
   * Position in the list determines the T-NNN ID (1-based).
   */
  static buildThreadIndex(allThreads: ReviewThread[]): ThreadIndex {
    const index: ThreadIndex = new Map();
    for (let i = 0; i < allThreads.length; i++) {
      index.set(allThreads[i].threadId, `T-${String(i + 1).padStart(3, '0')}`);
    }
    return index;
  }

  async createBundle(
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[],
    versions: ReviewVersion[],
    threadIndex: ThreadIndex,
  ): Promise<WorkspaceBundle> {
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();

    // Create directory structure
    await this.ensureDir(this.baseDir);
    await this.ensureDir(path.join(this.baseDir, 'threads'));
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    await this.ensureDir(path.join(this.baseDir, 'outputs'));

    const bundle: WorkspaceBundle = {
      sessionId,
      createdAt,
      target,
      threads,
      diffs,
      versions,
      outputDir: path.join(this.baseDir, 'outputs'),
    };

    // Write bundle files
    await this.writeSession({ id: sessionId, createdAt, targetRef: target, bundlePath: this.baseDir });
    await this.writeTarget(target);
    await this.clearThreadFiles();
    await this.writeThreads(threads, threadIndex);
    await this.writeDiffs(diffs);

    return bundle;
  }

  // ─── Session management ─────────────────────────────────

  async loadSession(): Promise<Session | null> {
    const sessionPath = path.join(this.baseDir, 'session.json');
    try {
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data) as Session;
    } catch {
      return null;
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'session.json'), session);
  }

  /**
   * Clear the session for a fresh start (--full mode).
   */
  async clearSession(): Promise<void> {
    const sessionPath = path.join(this.baseDir, 'session.json');
    try { await fs.unlink(sessionPath); } catch { /* may not exist */ }
  }

  /**
   * Remove the entire bundle directory (.review-assist/).
   */
  async removeBundle(): Promise<void> {
    try {
      await fs.rm(this.baseDir, { recursive: true, force: true });
    } catch {
      // May not exist
    }
  }

  /**
   * Append a published action to the current session.
   * Returns false if no session exists.
   */
  async appendPublishedAction(action: PublishedAction): Promise<boolean> {
    const session = await this.loadSession();
    if (!session) return false;
    session.publishedActions = session.publishedActions ?? [];
    session.publishedActions.push(action);
    await this.saveSession(session);
    return true;
  }

  /**
   * Remove entries from replies.json whose T-NNN no longer maps to
   * an active (unresolved) thread. Called on incremental runs to prevent
   * stale replies from being published to the wrong thread.
   */
  async pruneStaleReplies(activeThreadIds: Set<string>, threadIndex: ThreadIndex): Promise<number> {
    const repliesPath = path.join(this.baseDir, 'outputs', 'replies.json');
    let raw: string;
    try {
      raw = await fs.readFile(repliesPath, 'utf-8');
    } catch {
      return 0; // no replies file
    }

    let entries: { threadId: string; body: string; resolve?: boolean }[];
    try {
      entries = JSON.parse(raw);
      if (!Array.isArray(entries)) return 0;
    } catch {
      return 0;
    }

    const before = entries.length;
    // Build reverse map: T-NNN → SHA
    const reverseIndex = new Map<string, string>();
    for (const [sha, shortId] of threadIndex) {
      reverseIndex.set(shortId, sha);
    }
    const kept = entries.filter((e) => {
      const normalized = e.threadId.toUpperCase();
      // Resolve T-NNN → SHA using the reverse index, fall back to raw ID
      const sha = reverseIndex.get(normalized) ?? e.threadId;
      return activeThreadIds.has(sha);
    });

    if (kept.length < before) {
      await fs.writeFile(repliesPath, JSON.stringify(kept, null, 2), 'utf-8');
    }
    return before - kept.length;
  }

  // ─── Output helpers ─────────────────────────────────────

  async writeOutput(filename: string, content: string): Promise<string> {
    const outputPath = path.join(this.baseDir, 'outputs', filename);
    await fs.writeFile(outputPath, content, 'utf-8');
    return outputPath;
  }

  async readOutput(filename: string): Promise<string> {
    const outputPath = path.join(this.baseDir, 'outputs', filename);
    return fs.readFile(outputPath, 'utf-8');
  }

  /**
   * Resolve a T-NNN short reference to the full thread SHA.
   * Uses the provided thread index if available, falls back to reading thread JSON files on disk.
   * Returns the input unchanged if it doesn't match the T-NNN pattern.
   */
  async resolveThreadRef(ref: string, threadIndex?: ThreadIndex): Promise<string> {
    const match = ref.match(/^T-(\d{3,})$/i);
    if (!match) return ref; // already a full ID or other format

    const normalised = ref.toUpperCase();

    // Look up in the thread index (reverse: shortId → SHA)
    if (threadIndex) {
      for (const [sha, shortId] of threadIndex) {
        if (shortId === normalised) return sha;
      }
    }

    // Fallback: read the thread JSON file from disk
    const jsonPath = path.join(this.baseDir, 'threads', `${normalised}.json`);
    try {
      const data = await fs.readFile(jsonPath, 'utf-8');
      const thread = JSON.parse(data) as { threadId: string };
      if (!thread.threadId) throw new Error('threadId field missing');
      return thread.threadId;
    } catch {
      throw new Error(`Cannot resolve thread reference "${ref}" — not found in thread index or threads/ folder`);
    }
  }

  /**
   * Write CONTEXT.md — the agent entry point that explains what's in
   * the bundle and what to do next.
   */
  async writeContext(
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[],
    threadIndex: ThreadIndex,
    options?: {
      incremental?: boolean;
      previousThreadIds?: Set<string>;
      publishedActions?: PublishedAction[];
    },
  ): Promise<string> {
    const unresolvedThreads = threads.filter((t) => t.resolvable && !t.resolved);
    const generalComments = threads.filter((t) => !t.resolvable && !t.comments.every((c) => c.system));

    // Derive SELF/REPLIED from comment origins (marker-based, survives session resets)
    const selfThreadIds = new Set<string>();
    const repliedThreadIds = new Set<string>();
    for (const t of threads) {
      const nonSystem = t.comments.filter((c) => !c.system);
      if (nonSystem.length > 0 && nonSystem[0].origin === 'bot') {
        // First comment is ours → we created this thread
        selfThreadIds.add(t.threadId);
      } else if (nonSystem.some((c) => c.origin === 'bot')) {
        // Has a bot reply after a human comment → we replied
        repliedThreadIds.add(t.threadId);
      }
    }

    const lines: string[] = [];
    const mrType = target.targetType === 'merge_request' ? 'MR' : 'PR';

    lines.push(`# Review Context`);
    lines.push('');
    lines.push(`**${mrType} !${target.targetId}**: ${target.title}  `);
    lines.push(`**Author**: @${target.author}  `);
    lines.push(`**Branch**: \`${target.sourceBranch}\` → \`${target.targetBranch}\`  `);
    lines.push(`**Status**: ${unresolvedThreads.length} unresolved thread(s), ${diffs.length} changed file(s)  `);
    if (target.webUrl) lines.push(`**URL**: ${target.webUrl}  `);
    if (options?.incremental) lines.push(`**Mode**: Incremental review (changes since last review)  `);
    lines.push('');

    // MR description — important context for the reviewer
    if (target.description?.trim()) {
      lines.push('## MR Description');
      lines.push('');
      lines.push(target.description.trim());
      lines.push('');
    }

    // What's in the bundle
    lines.push('## Bundle Contents');
    lines.push('');
    lines.push('| Path | Description |');
    lines.push('|------|-------------|');
    lines.push('| `target.json` | MR/PR metadata |');
    const threadFileCount = unresolvedThreads.length + generalComments.length;
    if (threadFileCount > 0) {
      lines.push(`| \`threads/\` | ${threadFileCount} thread(s) — read the \`.md\` files |`);
    }
    lines.push(`| \`diffs/latest.patch\` | Full diff (${diffs.length} file(s)) |`);
    if (options?.incremental) {
      lines.push('| `diffs/incremental.patch` | Changes since last review |');
    }
    lines.push('| `outputs/` | Write results here |');
    lines.push('');

    // Thread overview table
    if (unresolvedThreads.length > 0) {
      lines.push('## Unresolved Threads');
      lines.push('');
      lines.push('| # | File |');
      lines.push('|---|------|');
      for (const t of unresolvedThreads) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const isNew = options?.previousThreadIds && !options.previousThreadIds.has(t.threadId);
        const isSelf = selfThreadIds.has(t.threadId);
        const isReplied = repliedThreadIds.has(t.threadId);
        const badges: string[] = [];
        if (isNew && !isSelf) badges.push('**NEW**');
        if (isSelf) badges.push('**SELF**');
        if (isReplied) badges.push('**REPLIED**');
        const badgeStr = badges.length > 0 ? ' ' + badges.join(' ') : '';
        const file = t.position?.filePath
          ? `\`${t.position.filePath}\`${t.position.newLine ? `:${t.position.newLine}` : ''}`
          : '(general)';
        lines.push(`| ${prefix}${badgeStr} | ${file} |`);
      }
      lines.push('');
    }

    // General (non-resolvable) comments for context
    if (generalComments.length > 0) {
      lines.push('## General Comments');
      lines.push('');
      lines.push('These are non-resolvable comments (general notes, not tied to specific code review threads).');
      lines.push('They may provide useful context but do not require a reply.');
      lines.push('');
      for (const t of generalComments) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const firstComment = t.comments.find((c) => !c.system);
        const snippet = firstComment?.body.split('\n')[0].slice(0, 120) ?? '';
        lines.push(`- **${prefix}** (@${firstComment?.author ?? '?'}): ${snippet}`);
      }
      lines.push('');
    }

    // Changed files overview
    lines.push('## Changed Files');
    lines.push('');
    for (const d of diffs) {
      const tag = d.newFile ? 'added' : d.deletedFile ? 'deleted' : d.renamedFile ? 'renamed' : 'modified';
      lines.push(`- \`${d.newPath || d.oldPath}\` (${tag})`);
    }
    lines.push('');

    // Incremental review notes
    if (options?.incremental && options?.previousThreadIds) {
      const newThreads = unresolvedThreads.filter((t) => !options.previousThreadIds!.has(t.threadId));
      const carriedOver = unresolvedThreads.filter((t) => options.previousThreadIds!.has(t.threadId));
      const resolvedCount = [...options.previousThreadIds].filter(
        (id) => !unresolvedThreads.some((t) => t.threadId === id),
      ).length;

      lines.push('## Incremental Review Summary');
      lines.push('');
      if (newThreads.length > 0) {
        lines.push(`- **${newThreads.length} new thread(s)** since last review (marked **NEW** above)`);
      }
      if (carriedOver.length > 0) {
        lines.push(`- **${carriedOver.length} carried-over thread(s)** still unresolved`);
      }
      if (resolvedCount > 0) {
        lines.push(`- **${resolvedCount} thread(s) resolved** since last review`);
      }
      lines.push('- Check `diffs/incremental.patch` for what changed since last review');
      lines.push('- Focus on **NEW** threads — carried-over threads may already have pending replies');
      lines.push('- Threads marked **SELF** were published by you in a prior iteration — skip unless still unresolved after your fix');
      lines.push('- Threads marked **REPLIED** already have a reply from a prior iteration');
      lines.push('');
    }

    // Previous actions — tell the agent what it already did
    if (options?.publishedActions && options.publishedActions.length > 0) {
      lines.push('## Previous Actions (this session)');
      lines.push('');
      lines.push('These actions were published by `review-assist` in prior iterations of this session.');
      lines.push('Threads marked **SELF** above were created by your findings. Do not re-raise the same issues.');
      lines.push('');
      lines.push('| Action | Target | Detail |');
      lines.push('|--------|--------|--------|');
      for (const a of options.publishedActions) {
        const actionLabel = a.type === 'reply' ? 'Reply' : a.type === 'finding' ? 'Finding' : 'Resolve';
        const target = a.filePath ? `${a.filePath}:${a.line ?? '?'}` : a.threadId;
        lines.push(`| ${actionLabel} | ${target} | ${a.detail.slice(0, 100)} |`);
      }
      lines.push('');
    }

    // Workflow instructions
    lines.push('## Suggested Workflow');
    lines.push('');
    lines.push('1. Read `REVIEW.md` and `.review-assist/rules.md` in the repo root if present');
    lines.push('2. Read each thread `.md` file in `.review-assist/threads/`');
    lines.push('3. Check the referenced source code and `diffs/latest.patch`');
    lines.push('4. For each existing thread decide: fix code, draft a reply, or both');
    lines.push('5. Review the full diff for additional issues not yet raised by reviewers');
    lines.push('6. Write results to `outputs/`:');
    lines.push('   - `outputs/replies.json` — replies to existing threads, use **T-NNN** short IDs:');
    lines.push('     ```json');
    lines.push('     [{ "threadId": "T-001", "body": "Fixed!", "resolve": true }]');
    lines.push('     ```');
    lines.push('   - `outputs/new-findings.json` — new issues found during proactive review:');
    lines.push('     ```json');
    lines.push('     [{ "filePath": "src/app.ts", "newLine": 42, "body": "Potential null dereference", "severity": "high", "category": "correctness" }]');
    lines.push('     ```');
    lines.push('     Each finding needs `filePath` and at least one of `newLine` / `oldLine`:');
    lines.push('     - **Added line** (line with `+` in the diff): set `newLine` only');
    lines.push('     - **Context line** (unchanged, visible in the diff): set both `newLine` and `oldLine`');
    lines.push('     - **Removed line** (line with `-` in the diff): set `oldLine` only');
    lines.push('     Read `diffs/latest.patch` hunk headers (`@@ -old,count +new,count @@`) to determine the correct values. For added/modified lines you can also verify `newLine` against the checked-out source file.');
    lines.push('   - `outputs/summary.md` — Changelog-style summary for the MR description (categorized by area: Bug Fixes, Improvements, New Features, Tests, Documentation, Chores). Do NOT include a file list or code walkthrough.');
    lines.push('   - `outputs/review-notes.md` — Your review notes for the synced MR comment (what you reviewed, what you found, what you fixed). This is updated each iteration.');
    lines.push('');
    lines.push('**Important**: Check existing threads and the Previous Actions table before creating new findings.');
    lines.push('Do not re-raise issues that are already tracked or were published by you (**SELF** threads).');
    lines.push('Only raise issues you are confident about. For trivial issues, fix the code directly.');
    lines.push('');
    lines.push('Publish results back to GitLab/GitHub:');
    lines.push('```');
    lines.push(`review-assist publish                  # publish everything pending (replies + findings + notes)`);
    lines.push(`review-assist publish replies           # publish all replies (removes published entries)`);
    lines.push(`review-assist publish replies T-001     # publish one specific reply`);
    lines.push(`review-assist publish findings          # publish new findings (removes published entries)`);
    lines.push(`review-assist publish description --from-summary   # update MR description`);
    lines.push(`review-assist publish notes             # create/update review comment on the MR`);
    lines.push('```');

    const content = lines.join('\n');
    const contextPath = path.join(this.baseDir, 'CONTEXT.md');
    await fs.writeFile(contextPath, content, 'utf-8');
    return contextPath;
  }

  // ─── Internal helpers ───────────────────────────────────

  /**
   * Remove all files from the threads/ directory before rewriting.
   */
  private async clearThreadFiles(): Promise<void> {
    const threadsDir = path.join(this.baseDir, 'threads');
    try {
      const files = await fs.readdir(threadsDir);
      await Promise.all(
        files.map((f) => fs.unlink(path.join(threadsDir, f))),
      );
    } catch {
      // Directory may not exist yet
    }
  }

  // ─── Write helpers ──────────────────────────────────────

  private async writeSession(session: Session): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'session.json'), session);
  }

  private async writeTarget(target: ReviewTarget): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'target.json'), target);
  }

  private async writeThreads(threads: ReviewThread[], threadIndex: ThreadIndex): Promise<void> {
    for (const thread of threads) {
      const prefix = threadIndex.get(thread.threadId) ?? `T-${String(threads.indexOf(thread) + 1).padStart(3, '0')}`;

      // JSON version
      await this.writeJson(path.join(this.baseDir, 'threads', `${prefix}.json`), thread);

      // Markdown version for human/agent reading
      const md = this.threadToMarkdown(thread, prefix);
      await fs.writeFile(path.join(this.baseDir, 'threads', `${prefix}.md`), md, 'utf-8');
    }
  }

  private async writeDiffs(diffs: ReviewDiff[]): Promise<void> {
    const patchContent = diffs.map((d) => {
      const header = `diff --git a/${d.oldPath} b/${d.newPath}`;
      return `${header}\n${d.diff}`;
    }).join('\n');

    await fs.writeFile(path.join(this.baseDir, 'diffs', 'latest.patch'), patchContent, 'utf-8');
  }

  async writeIncrementalDiff(diffs: ReviewDiff[]): Promise<void> {
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    const patchContent = diffs.map((d) => {
      const header = `diff --git a/${d.oldPath} b/${d.newPath}`;
      return `${header}\n${d.diff}`;
    }).join('\n');

    await fs.writeFile(path.join(this.baseDir, 'diffs', 'incremental.patch'), patchContent, 'utf-8');
  }

  private threadToMarkdown(thread: ReviewThread, prefix: string): string {
    const lines: string[] = [];
    lines.push(`# ${prefix}: Thread ${thread.threadId}`);
    lines.push('');
    lines.push(`- **Status**: ${thread.resolved ? 'Resolved' : 'Unresolved'}`);
    lines.push(`- **Resolvable**: ${thread.resolvable}`);
    if (thread.position) {
      lines.push(`- **File**: \`${thread.position.filePath}\``);
      if (thread.position.newLine) lines.push(`- **Line**: ${thread.position.newLine}`);
    }
    lines.push('');
    lines.push('## Comments');
    lines.push('');
    for (const comment of thread.comments) {
      if (comment.system) {
        // System comments (e.g. "changed this line in version 5") — shown dimmed
        lines.push(`> **System** — ${comment.createdAt}`);
        lines.push(`> ${comment.body}`);
        lines.push('');
      } else {
        lines.push(`### ${comment.author} (${comment.origin}) — ${comment.createdAt}`);
        lines.push('');
        lines.push(comment.body);
        lines.push('');
      }
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new WorkspaceError(`Failed to create directory ${dir}: ${err}`);
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
