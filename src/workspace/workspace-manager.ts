import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  ReviewTarget,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
  WorkspaceBundle,
  BundleState,
  BundlePublishedAction,
  PrepareSummary
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

  constructor(workingDir: string, bundleDirName = '.revkit') {
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
    const preparedAt = new Date().toISOString();

    // Create directory structure
    await this.ensureDir(this.baseDir);
    await this.ensureDir(path.join(this.baseDir, 'threads'));
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    await this.ensureDir(path.join(this.baseDir, 'outputs'));

    const bundle: WorkspaceBundle = {
      preparedAt,
      target,
      threads,
      diffs,
      versions,
      bundlePath: this.baseDir,
      outputDir: path.join(this.baseDir, 'outputs'),
    };

    // Write description.md (raw MR/PR description)
    await this.writeDescription(target.description);

    // Write thread files
    await this.clearThreadFiles();
    await this.writeThreads(threads, threadIndex);

    // Write diffs and line map
    await this.writeDiffs(diffs);
    await this.writeLineMap();

    // Ensure output placeholders exist (preserve existing outputs)
    await this.ensureDefaultOutputFiles();
    await this.writeOutputSchemas();

    // Write .gitignore to exclude bundle from version control
    await this.writeGitignore();

    return bundle;
  }

  // ─── Bundle state management (bundle.json) ──────────────

  async loadBundleState(): Promise<BundleState | null> {
    const bundlePath = path.join(this.baseDir, 'bundle.json');
    try {
      const data = await fs.readFile(bundlePath, 'utf-8');
      return JSON.parse(data) as BundleState;
    } catch {
      return null;
    }
  }

  async saveBundleState(state: BundleState): Promise<void> {
    await this.ensureDir(this.baseDir);
    await this.writeJson(path.join(this.baseDir, 'bundle.json'), state);
  }

  /**
   * Build the BundleState from current prepare data and optional previous state.
   */
  buildBundleState(
    target: ReviewTarget,
    threads: ReviewThread[],
    versions: ReviewVersion[],
    threadIndex: ThreadIndex,
    prepareSummary: PrepareSummary,
    previousActions?: BundlePublishedAction[],
  ): BundleState {
    const latestVersionId = versions.length > 0 ? versions[0].versionId : undefined;

    return {
      schemaVersion: 1,
      preparedAt: new Date().toISOString(),
      tool: { name: 'revkit', version: '0.1.0' },
      target: {
        provider: target.provider,
        repository: target.repository,
        type: target.targetType,
        id: target.targetId,
        title: target.title,
        descriptionPath: '.revkit/description.md',
        author: target.author,
        state: target.state,
        sourceBranch: target.sourceBranch,
        targetBranch: target.targetBranch,
        webUrl: target.webUrl,
        createdAt: target.createdAt,
        updatedAt: target.updatedAt,
        labels: target.labels,
        diffRefs: target.diffRefs,
        providerVersionId: latestVersionId,
      },
      prepare: prepareSummary,
      threads: {
        knownProviderThreadIds: threads.map((t) => t.threadId),
        shortIdMapping: [...threadIndex].map(([providerThreadId, shortId]) => ({
          shortId,
          providerThreadId,
        })),
      },
      publishedActions: previousActions ?? [],
      paths: {
        context: '.revkit/CONTEXT.md',
        instructions: '.revkit/INSTRUCTIONS.md',
        description: '.revkit/description.md',
        latestPatch: '.revkit/diffs/latest.patch',
        incrementalPatch: prepareSummary.codeChangedSincePreviousPrepare
          ? '.revkit/diffs/incremental.patch'
          : null,
        lineMap: '.revkit/diffs/line-map.json',
        outputs: '.revkit/outputs',
      },
    };
  }

  /**
   * Append a published action to the current bundle state.
   */
  async appendPublishedAction(action: BundlePublishedAction): Promise<boolean> {
    const state = await this.loadBundleState();
    if (!state) return false;
    state.publishedActions.push(action);
    await this.saveBundleState(state);
    return true;
  }

  /**
   * Remove the entire bundle directory (.revkit/).
   */
  async removeBundle(): Promise<void> {
    try {
      await fs.rm(this.baseDir, { recursive: true, force: true });
    } catch {
      // May not exist
    }
  }

  /**
   * Discard pending output files (reset to empty).
   */
  async discardOutputs(): Promise<void> {
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
        await fs.writeFile(filePath, content, 'utf-8');
      } catch { /* outputs dir may not exist yet */ }
    }
  }

  /**
   * Write the raw MR/PR description to description.md.
   */
  async writeDescription(description: string): Promise<void> {
    const descPath = path.join(this.baseDir, 'description.md');
    await fs.writeFile(descPath, description ?? '', 'utf-8');
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
   * Write CONTEXT.md — the agent-readable context file.
   * Contains MR/PR summary, prepare state, bundle contents, threads, and actions.
   * Does NOT contain output schemas, severity definitions, or positional tutorials.
   */
  async writeContext(
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[],
    threadIndex: ThreadIndex,
    options?: {
      prepareSummary?: PrepareSummary;
      publishedActions?: BundlePublishedAction[];
    },
  ): Promise<string> {
    const unresolvedThreads = threads.filter((t) => t.resolvable && !t.resolved);
    const generalComments = threads.filter((t) => !t.resolvable && !t.comments.every((c) => c.system));

    // Derive SELF/REPLIED from comment origins (marker-based)
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

    // ─── Target table ─────────────────────────────────────
    lines.push('# Review Context');
    lines.push('');
    lines.push('## Target');
    lines.push('');
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| Type | ${target.provider === 'gitlab' ? 'GitLab merge request' : 'GitHub pull request'} |`);
    lines.push(`| ${mrType} | !${target.targetId} — ${target.title} |`);
    lines.push(`| Repository | \`${target.repository}\` |`);
    lines.push(`| Author | @${target.author} |`);
    lines.push(`| Source branch | \`${target.sourceBranch}\` |`);
    lines.push(`| Target branch | \`${target.targetBranch}\` |`);
    lines.push(`| State | ${target.state} |`);
    if (target.webUrl) lines.push(`| URL | ${target.webUrl} |`);
    lines.push('');
    lines.push('Read `.revkit/INSTRUCTIONS.md` for the review workflow, output formats, and quality guidelines.');
    lines.push('');

    // ─── Prepare Summary ──────────────────────────────────
    const ps = options?.prepareSummary;
    if (ps) {
      lines.push('## Prepare Summary');
      lines.push('');
      lines.push('| Field | Value |');
      lines.push('|---|---|');
      lines.push(`| Prepared at | ${new Date().toISOString()} |`);
      lines.push(`| Mode | ${ps.mode} |`);
      if (ps.codeChangedSincePreviousPrepare !== null) {
        lines.push(`| Code changed since previous prepare | ${ps.codeChangedSincePreviousPrepare ? 'yes' : 'no'} |`);
      }
      if (ps.threadsChangedSincePreviousPrepare !== null) {
        lines.push(`| Threads changed since previous prepare | ${ps.threadsChangedSincePreviousPrepare ? 'yes' : 'no'} |`);
      }
      if (ps.previous) {
        lines.push(`| Previous head SHA | \`${ps.previous.headSha}\` |`);
      }
      lines.push(`| Current head SHA | \`${ps.current.headSha}\` |`);
      lines.push('');

      // Mode-specific context guidance
      if (ps.mode === 'fresh') {
        lines.push('This is a fresh prepared bundle. There is no previous prepare to compare against.');
        lines.push('');
      } else if (ps.codeChangedSincePreviousPrepare) {
        lines.push('This refresh detected new code changes since the previous prepare. Focus proactive review on the incremental patch and unresolved thread updates.');
        lines.push('');
      } else {
        lines.push('This refresh did not detect code changes since the previous prepare. Focus on new or unresolved thread updates and pending outputs. Do not perform a full proactive review unless requested.');
        lines.push('');
      }
    }

    // ─── Suggested Reading Order ──────────────────────────
    lines.push('## Suggested Reading Order');
    lines.push('');
    lines.push('1. Read this context file.');
    lines.push('2. Read `REVIEW.md` in the repository root if present.');
    lines.push('3. Read `.revkit/INSTRUCTIONS.md`.');
    lines.push('4. Read relevant thread files in `.revkit/threads/`.');
    lines.push('5. Review `.revkit/diffs/latest.patch` and `.revkit/diffs/line-map.json`.');
    lines.push('6. Inspect checked-out source files when needed.');
    lines.push('');

    // ─── MR/PR Description ────────────────────────────────
    lines.push('## MR/PR Description');
    lines.push('');
    lines.push('The raw MR/PR description is available at `.revkit/description.md`.');
    lines.push('');
    lines.push('Treat it as context only. Verify behavior against the diff and source code.');
    lines.push('');

    // ─── Bundle Contents ──────────────────────────────────
    lines.push('## Bundle Contents');
    lines.push('');
    lines.push('| Path | Description |');
    lines.push('|---|---|');
    lines.push('| `.revkit/INSTRUCTIONS.md` | Stable review workflow and output format rules |');
    lines.push('| `.revkit/bundle.json` | Machine-readable bundle metadata and local state |');
    lines.push('| `.revkit/description.md` | Raw MR/PR description |');
    const threadFileCount = unresolvedThreads.length + generalComments.length;
    if (threadFileCount > 0) {
      lines.push(`| \`.revkit/threads/\` | ${threadFileCount} thread(s) — read the \`.md\` files |`);
    }
    lines.push(`| \`.revkit/diffs/latest.patch\` | Full target diff (${diffs.length} file(s)) |`);
    lines.push('| `.revkit/diffs/line-map.json` | Valid positional anchors |');
    if (ps?.codeChangedSincePreviousPrepare) {
      lines.push('| `.revkit/diffs/incremental.patch` | Code changes since previous prepare |');
    }
    lines.push('| `.revkit/outputs/` | Agent output files |');
    lines.push('');

    // ─── Changed Files ────────────────────────────────────
    lines.push('## Changed Files');
    lines.push('');
    lines.push('| File | Status |');
    lines.push('|---|---|');
    for (const d of diffs) {
      const tag = d.newFile ? 'added' : d.deletedFile ? 'deleted' : d.renamedFile ? 'renamed' : 'modified';
      lines.push(`| \`${d.newPath || d.oldPath}\` | ${tag} |`);
    }
    lines.push('');

    // ─── Unresolved Threads ───────────────────────────────
    if (unresolvedThreads.length > 0) {
      lines.push('## Unresolved Threads');
      lines.push('');
      lines.push('| Thread | Flags | Author | Location | Summary |');
      lines.push('|---|---|---|---|---|');
      for (const t of unresolvedThreads) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const isSelf = selfThreadIds.has(t.threadId);
        const isReplied = repliedThreadIds.has(t.threadId);
        const badges: string[] = [];
        if (isSelf) badges.push('SELF');
        if (isReplied) badges.push('REPLIED');
        const flagStr = badges.length > 0 ? badges.join(', ') : '';

        const firstComment = t.comments.find((c) => !c.system);
        const author = firstComment?.author ?? '?';
        const file = t.position?.filePath
          ? `\`${t.position.filePath}\`${t.position.newLine ? `:${t.position.newLine}` : ''}`
          : 'general';
        const snippet = firstComment?.body.split('\n')[0].slice(0, 80) ?? '';
        lines.push(`| ${prefix} | ${flagStr} | @${author} | ${file} | ${snippet} |`);
      }
      lines.push('');
    }

    // ─── General Comments ─────────────────────────────────
    if (generalComments.length > 0) {
      lines.push('## General Comments');
      lines.push('');
      for (const t of generalComments) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const firstComment = t.comments.find((c) => !c.system);
        const snippet = firstComment?.body.split('\n')[0].slice(0, 120) ?? '';
        lines.push(`- **${prefix}** (@${firstComment?.author ?? '?'}): ${snippet}`);
      }
      lines.push('');
    }

    // ─── Previous Actions ─────────────────────────────────
    if (options?.publishedActions && options.publishedActions.length > 0) {
      lines.push('## Previous Actions');
      lines.push('');
      lines.push('These actions were published by `revkit` in prior iterations. Do not re-raise the same issues.');
      lines.push('');
      lines.push('| Action | Location | Severity | Category | Title |');
      lines.push('|---|---|---|---|---|');
      for (const a of options.publishedActions) {
        const actionLabel = a.type === 'reply' ? 'Reply' : a.type === 'finding' ? 'Finding' : 'Resolve';
        const loc = a.location
          ? `\`${a.location.newPath || a.location.oldPath}\`:${a.location.newLine ?? a.location.oldLine ?? '?'}`
          : a.providerThreadId ?? '';
        lines.push(`| ${actionLabel} | ${loc} | ${a.severity ?? ''} | ${a.category ?? ''} | ${a.title ?? ''} |`);
      }
      lines.push('');
    }

    const content = lines.join('\n');
    const contextPath = path.join(this.baseDir, 'CONTEXT.md');
    await fs.writeFile(contextPath, content, 'utf-8');

    // Also write INSTRUCTIONS.md
    await this.writeInstructions();

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

  /**
   * Write INSTRUCTIONS.md — copied from the package templates directory.
   */
  async writeInstructions(): Promise<void> {
    const thisFile = fileURLToPath(import.meta.url);
    // dist/workspace/workspace-manager.js -> package root -> templates/
    const templatesDir = path.resolve(path.dirname(thisFile), '..', '..', 'templates');
    const source = path.join(templatesDir, 'INSTRUCTIONS.md');
    const dest = path.join(this.baseDir, 'INSTRUCTIONS.md');
    await fs.copyFile(source, dest);
  }

  /**
   * Write .gitignore to exclude the entire bundle dir from version control.
   */
  private async writeGitignore(): Promise<void> {
    await fs.writeFile(path.join(this.baseDir, '.gitignore'), '*\n', 'utf-8');
  }

  /**
   * Write an explicit "no code changes" incremental patch.
   */
  async writeNoCodeChangeIncrementalPatch(): Promise<void> {
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    await fs.writeFile(
      path.join(this.baseDir, 'diffs', 'incremental.patch'),
      '# No code changes since previous prepare.\n',
      'utf-8',
    );
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
