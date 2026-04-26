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
import { parsePatch } from './patch-parser.js';

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
    await this.writeLineMap();
    await this.ensureDefaultOutputFiles();
    await this.writeOutputSchemas();

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
        selfThreadIds.add(t.threadId);
      } else if (nonSystem.some((c) => c.origin === 'bot')) {
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
    lines.push('> Read `.review-assist/INSTRUCTIONS.md` for detailed review workflow, output formats, and quality guidelines.');
    lines.push('');
    // Suggested reading order
    lines.push('## Suggested reading order');
    lines.push('');
    lines.push('1. Read this context file.');
    lines.push('2. Read `REVIEW.md` in the repo root if present');
    lines.push('3. Read `.review-assist/INSTRUCTIONS.md`');
    lines.push('4. Read relevant thread files in `.review-assist/threads/`');
    lines.push('5. Review `diffs/latest.patch` and `diffs/line-map.json`.');
    lines.push('6. Inspect checked-out source files when needed to understand changed behavior.');
    lines.push('');

    // Incremental review summary
    if (options?.incremental && options?.previousThreadIds) {
      lines.push('## Review Mode Notes');
      lines.push('');
      lines.push('This is an incremental review.')
      lines.push('')
      lines.push('Focus on:')
      lines.push('- new changes since the last review');
      lines.push('- unresolved threads that need a useful reply');
      lines.push('issues not already covered by previous actions');
      lines.push('');
      lines.push('Avoid:')
      lines.push('- re-raising previous review-assist findings');
      lines.push('- replying to SELF or REPLIED threads unless there is new information');
      lines.push('');
    }

    // MR description
    if (target.description?.trim()) {
      lines.push('## MR Description');
      lines.push('');
      lines.push('The description below is existing author-provided or previously generated text. ' +
          'Treat it as context only. Verify behavior against the diff and source code.');
      lines.push('');
      lines.push('````markdown')
      lines.push(target.description.trim());
      lines.push('````');
      lines.push('');
    }

    // Bundle contents
    lines.push('## Bundle Contents');
    lines.push('');
    lines.push('| Path | Description |');
    lines.push('|------|-------------|');
    lines.push('| `.review-assist/INSTRUCTIONS.md` | Stable review workflow and output format rules |');
    lines.push('| `.review-assist/target.json` | MR/PR metadata |');
    const threadFileCount = unresolvedThreads.length + generalComments.length;
    if (threadFileCount > 0) {
      lines.push(`| \`.review-assist/threads/\` | ${threadFileCount} thread(s) — read the \`.md\` files |`);
    }
    lines.push(`| \`.review-assist/diffs/latest.patch\` | Full diff (${diffs.length} file(s)) |`);
    lines.push('| `.review-assist/diffs/line-map.json` | Parsed line map for positional anchors |');
    if (options?.incremental) {
      lines.push('| `.review-assist/diffs/incremental.patch` | Changes since last review |');
    }
    lines.push('| `.review-assist/outputs/` | Write results here |');
    lines.push('');

    // Changed files
    lines.push('## Changed Files');
    lines.push('');
    for (const d of diffs) {
      const tag = d.newFile ? 'added' : d.deletedFile ? 'deleted' : d.renamedFile ? 'renamed' : 'modified';
      lines.push(`- \`${d.newPath || d.oldPath}\` (${tag})`);
    }
    lines.push('');

    // Thread overview
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

    // General comments
    if (generalComments.length > 0) {
      lines.push('## General Comments');
      lines.push('');
      lines.push('General comments are non-resolvable MR/PR notes. They may provide context but usually do not require replies.');
      lines.push('');
      for (const t of generalComments) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const firstComment = t.comments.find((c) => !c.system);
        const snippet = firstComment?.body.split('\n')[0].slice(0, 120) ?? '';
        lines.push(`- **${prefix}** (@${firstComment?.author ?? '?'}): ${snippet}`);
      }
      lines.push('');
    }

    // Previous actions
    if (options?.publishedActions && options.publishedActions.length > 0) {
      lines.push('## Previous Actions (this session)');
      lines.push('');
      lines.push('These actions were published by `review-assist` in prior iterations of this session. Do not re-raise the same issues.');
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

    const content = lines.join('\n');
    const contextPath = path.join(this.baseDir, 'CONTEXT.md');
    await fs.writeFile(contextPath, content, 'utf-8');
    return contextPath;
  }

  // ─── Line map & output scaffolding ──────────────────────

  /**
   * Parse diffs/latest.patch and write diffs/line-map.json.
   */
  private async writeLineMap(): Promise<void> {
    const patchPath = path.join(this.baseDir, 'diffs', 'latest.patch');
    let patchContent: string;
    try {
      patchContent = await fs.readFile(patchPath, 'utf-8');
    } catch {
      return; // No patch file yet
    }
    const lineMap = parsePatch(patchContent);
    await this.writeJson(path.join(this.baseDir, 'diffs', 'line-map.json'), lineMap);
  }

  /**
   * Ensure default empty output files exist so agents and automation
   * always have a predictable set of files.
   */
  private async ensureDefaultOutputFiles(): Promise<void> {
    const outputDir = path.join(this.baseDir, 'outputs');
    const defaults: [string, string][] = [
      ['replies.json', '[]'],
      ['new-findings.json', '[]'],
      ['summary.md', ''],
      ['review-notes.md', ''],
    ];
    for (const [name, content] of defaults) {
      const filePath = path.join(outputDir, name);
      try {
        await fs.access(filePath);
        // File exists — don't overwrite
      } catch {
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }
  }

  /**
   * Write JSON schema files for output validation.
   */
  private async writeOutputSchemas(): Promise<void> {
    const outputDir = path.join(this.baseDir, 'outputs');
    await fs.writeFile(
      path.join(outputDir, 'new-findings.schema.json'),
      JSON.stringify(NEW_FINDINGS_JSON_SCHEMA, null, 2),
      'utf-8',
    );
    await fs.writeFile(
      path.join(outputDir, 'replies.schema.json'),
      JSON.stringify(REPLIES_JSON_SCHEMA, null, 2),
      'utf-8',
    );
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

// ─── JSON Schemas for output files ────────────────────────

const NEW_FINDINGS_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'new-findings',
  description: 'Array of review findings to publish as GitLab/GitHub diff threads.',
  type: 'array',
  items: {
    type: 'object',
    required: ['oldPath', 'newPath', 'body', 'severity', 'category'],
    properties: {
      oldPath: { type: 'string', minLength: 1, description: 'Path in the old (base) version of the diff.' },
      newPath: { type: 'string', minLength: 1, description: 'Path in the new (head) version of the diff.' },
      oldLine: { type: 'integer', minimum: 1, description: 'Line number in the old file (for removed/context lines).' },
      newLine: { type: 'integer', minimum: 1, description: 'Line number in the new file (for added/context lines).' },
      body: { type: 'string', minLength: 1, description: 'Review comment body (markdown).' },
      severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low', 'nit'] },
      category: {
        type: 'string',
        enum: ['security', 'correctness', 'performance', 'testing', 'architecture', 'style', 'documentation', 'naming', 'error-handling', 'general'],
      },
    },
    anyOf: [
      { required: ['oldLine'] },
      { required: ['newLine'] },
    ],
    additionalProperties: false,
  },
};

const REPLIES_JSON_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'replies',
  description: 'Array of replies to existing MR/PR threads.',
  type: 'array',
  items: {
    type: 'object',
    required: ['threadId', 'body', 'resolve'],
    properties: {
      threadId: { type: 'string', minLength: 1, pattern: '^T-\\d{3,}$', description: 'T-NNN short ID of the thread.' },
      body: { type: 'string', minLength: 1, description: 'Reply body (markdown).' },
      resolve: { type: 'boolean', description: 'Whether to resolve the thread after replying.' },
      disposition: {
        type: 'string',
        enum: ['already_fixed', 'explain', 'suggest_fix', 'disagree', 'escalate'],
        description: 'Internal disposition tag (not published to GitLab).',
      },
    },
    additionalProperties: false,
  },
};
