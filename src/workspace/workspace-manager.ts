import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  BundleLocal,
  BundleOutputs,
  BundlePublishedAction,
  BundleState,
  BundleThreadItem,
  OutputState,
  PrepareSummary,
  ReviewDiff,
  ReviewTarget,
  ReviewThread,
  ReviewVersion,
  WorkspaceBundle,
} from '../core/types.js';
import { WorkspaceError } from '../core/errors.js';
import { type FileEntry as PatchFileEntry, type LineMap, parsePatch } from './patch-parser.js';
import type { GitHelper } from './git-helper.js';
import { computeContentHash, computeThreadDigest, DIGEST_VERSION } from './thread-digest.js';
import {
  canonicalThreadComments,
  firstNonSystemComment,
  isSystemOnlyThread,
  latestNonSystemComment,
  nonSystemThreadComments,
} from './thread-utils.js';
import { sanitizeDescriptionForAgent } from './checkpoint.js';

/**
 * Map from thread SHA → stable T-NNN short ID.
 * Derived from position in the provider's all-threads list
 * (which is ordered by creation date and never reorders).
 */
export type ThreadIndex = Map<string, string>;

const OUTPUT_DEFAULTS: readonly [filename: string, content: string][] = [
  ['replies.json', '[]'],
  ['new-findings.json', '[]'],
  ['summary.md', ''],
  ['review.md', ''],
];

const OUTPUT_STATE_KEYS = {
  'summary.md': 'summary',
  'review.md': 'review',
} as const;

export class WorkspaceManager {
  private readonly workingDir: string;
  private readonly baseDir: string;

  constructor(workingDir: string) {
    this.workingDir = workingDir;
    this.baseDir = path.join(workingDir, '.revkit');
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
    await this.writeThreads(threads, threadIndex, diffs, target.diffRefs.headSha);

    // Write diffs and diff bundle artifacts
    await this.writeDiffs(diffs);
    await this.writeDiffBundle();

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
    localMetadata: BundleLocal,
    previousActions?: BundlePublishedAction[],
    previousOutputs?: BundleOutputs,
    bundledThreads: ReviewThread[] = threads,
  ): BundleState {
    const latestVersionId = versions.length > 0 ? versions[0].versionId : undefined;

    // Build thread items with digests
    const threadItems: BundleThreadItem[] = bundledThreads
      .filter((t) => !isSystemOnlyThread(t))
      .map((t) => {
        const shortId = threadIndex.get(t.threadId) ?? '?';
        const latestComment = latestNonSystemComment(t);
        return {
          shortId,
          providerThreadId: t.threadId,
          file: `.revkit/threads/${shortId}.json`,
          markdownFile: `.revkit/threads/${shortId}.md`,
          resolved: t.resolved,
          resolvable: t.resolvable,
          commentsCount: t.comments.length,
          latestCommentAt: latestComment?.createdAt ?? null,
          digest: computeThreadDigest(t),
        };
      });

    return {
      schemaVersion: 2,
      preparedAt: new Date().toISOString(),
      tool: { name: 'revkit', version: '0.2.0' },
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
      local: localMetadata,
      prepare: prepareSummary,
      threads: {
        digestVersion: DIGEST_VERSION,
        digest: prepareSummary.current.threadsDigest,
        items: threadItems,
      },
      outputs: previousOutputs ?? {
        summary: { path: '.revkit/outputs/summary.md' },
        review: { path: '.revkit/outputs/review.md' },
      },
      publishedActions: previousActions ?? [],
      paths: {
        context: '.revkit/CONTEXT.md',
        contract: '.revkit/AGENT_CONTRACT.md',
        instructions: '.revkit/INSTRUCTIONS.md',
        instructionsDir: '.revkit/instructions/',
        description: '.revkit/description.md',
        latestPatch: '.revkit/diffs/latest.patch',
        incrementalPatch: prepareSummary.comparison.targetCodeChangedSinceCheckpoint
          ? '.revkit/diffs/incremental.patch'
          : null,
        filesJson: '.revkit/diffs/files.json',
        lineMapNdjson: '.revkit/diffs/line-map.ndjson',
        changeBlocks: '.revkit/diffs/change-blocks.json',
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
   * Update the publish hash for an output file in bundle.json.
   */
  async updateOutputPublishState(
    outputKey: 'summary' | 'review',
    hash: string,
    targetHeadSha: string,
    providerNoteId?: string,
  ): Promise<boolean> {
    const state = await this.loadBundleState();
    if (!state) return false;
    const entry = state.outputs[outputKey];
    entry.lastPublishedHash = hash;
    entry.lastPublishedAt = new Date().toISOString();
    entry.lastPublishedTargetHeadSha = targetHeadSha;
    if (providerNoteId !== undefined) {
      entry.providerNoteId = providerNoteId;
    }
    await this.saveBundleState(state);
    return true;
  }

  /**
   * Compute the current state of an output file relative to its publish hash.
   */
  async getOutputState(outputKey: 'summary' | 'review'): Promise<OutputState> {
    const state = await this.loadBundleState();
    if (!state) return 'empty';
    const entry = state.outputs[outputKey];
    const filePath = path.resolve(this.workingDir, entry.path);
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf-8');
    } catch {
      return 'empty';
    }
    if (!content.trim()) return 'empty';
    if (!entry.lastPublishedHash) return 'pending';
    const currentHash = computeContentHash(content);
    return currentHash === entry.lastPublishedHash ? 'published' : 'modified since publish';
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
    for (const [name, content] of OUTPUT_DEFAULTS) {
      const filePath = path.join(outputDir, name);
      try {
        await fs.writeFile(filePath, content, 'utf-8');
      } catch {
        /* outputs dir may not exist yet */
      }
    }
  }

  /**
   * Prefill an output file with content from the last published review note,
   * but only if the file is currently empty. This lets agents see and update
   * existing content in incremental mode without triggering a "changed" state
   * on the next status check (the publish hash stays matched).
   */
  async prefillOutputIfEmpty(filename: string, content: string): Promise<void> {
    const filePath = path.join(this.baseDir, 'outputs', filename);
    try {
      const existing = await fs.readFile(filePath, 'utf-8');
      if (existing.trim()) return; // already has content — don't overwrite
    } catch {
      // File doesn't exist — write it
    }
    await fs.writeFile(filePath, content, 'utf-8');

    // Update the publish hash so status doesn't detect this as "pending"
    const state = await this.loadBundleState();
    if (state) {
      const outputKey = OUTPUT_STATE_KEYS[filename as keyof typeof OUTPUT_STATE_KEYS] ?? null;
      if (outputKey) {
        const entry = state.outputs[outputKey];
        entry.lastPublishedHash = computeContentHash(content);
        await this.saveBundleState(state);
      }
    }
  }

  /**
   * Write the sanitized MR/PR description to description.md.
   * Strips the hidden revkit state block so agents never see it.
   */
  async writeDescription(description: string): Promise<void> {
    const sanitized = sanitizeDescriptionForAgent(description ?? '');
    const descPath = path.join(this.baseDir, 'description.md');
    await fs.writeFile(descPath, sanitized, 'utf-8');
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
      entries = JSON.parse(raw) as { threadId: string; body: string; resolve?: boolean }[];
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
      const normalized = e.threadId.trim().toUpperCase();
      // Resolve T-NNN → SHA using the reverse index, fall back to raw ID
      const sha = reverseIndex.get(normalized) ?? e.threadId.trim();
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
      changedThreadIds?: Set<string>;
      allThreads?: ReviewThread[];
    },
  ): Promise<string> {
    const unresolvedThreads = threads.filter((t) => t.resolvable && !t.resolved);
    const generalComments = threads.filter((t) => !t.resolvable && !isSystemOnlyThread(t));

    const tableCell = (value: string): string => value.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');

    // Format a thread's file position as a markdown-friendly location string.
    const threadLocation = (t: ReviewThread): string => {
      if (!t.position?.filePath) return 'general';
      const lineNum = t.position.newLine ?? t.position.oldLine;
      return `\`${tableCell(t.position.filePath)}\`${lineNum ? `:${lineNum}` : ''}`;
    };

    // Strip the bot-published marker and find the first meaningful line of a comment body.
    // For revkit findings, skip the severity/category metadata line (e.g. "_🔴 High_ | _security_").
    const cleanSnippet = (body: string, maxLen: number): string => {
      const lines = body.replace(/^\s*<!-- revkit -->\s*\n?/, '').split('\n');
      const meaningful = lines.find((l) => {
        const trimmed = l.trim();
        if (!trimmed) return false;
        // Skip lines that are only severity/category badges like "_🔴 High_ | _security_"
        if (/^_[^_]+_(\s*\|\s*_[^_]+_)*\s*$/.test(trimmed)) return false;
        return true;
      });
      return tableCell(meaningful?.trim().slice(0, maxLen) ?? '');
    };

    // Derive SELF/REPLIED from comment origins (marker-based)
    const selfThreadIds = new Set<string>();
    const repliedThreadIds = new Set<string>();
    for (const t of threads) {
      const nonSystem = nonSystemThreadComments(t);
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
    lines.push(`| ${mrType} | !${target.targetId} — ${tableCell(target.title)} |`);
    lines.push(`| Repository | \`${tableCell(target.repository)}\` |`);
    lines.push(`| Author | @${tableCell(target.author)} |`);
    lines.push(`| Source branch | \`${tableCell(target.sourceBranch)}\` |`);
    lines.push(`| Target branch | \`${tableCell(target.targetBranch)}\` |`);
    lines.push(`| State | ${tableCell(target.state)} |`);
    if (target.webUrl) lines.push(`| URL | ${target.webUrl} |`);
    lines.push('');
    lines.push('Read `.revkit/AGENT_CONTRACT.md` first. It contains the short mandatory review contract.');
    lines.push('');
    lines.push(
      'Then read `.revkit/INSTRUCTIONS.md`. It is an index for task-specific instruction files, not the full review manual.',
    );
    lines.push('');
    lines.push(
      'For this run, read only the instruction files listed in **Required Instructions for This Run** unless you need additional detail.',
    );
    lines.push('');

    // ─── Review Checkpoint Summary ──────────────────────────
    const ps = options?.prepareSummary;
    if (ps) {
      lines.push('## Review Checkpoint Summary');
      lines.push('');

      if (ps.checkpoint) {
        lines.push('| Field | Value |');
        lines.push('|---|---|');
        lines.push(`| Last review checkpoint | ${ps.checkpoint.createdAt} |`);
        lines.push(`| Last reviewed head SHA | \`${ps.checkpoint.headSha}\` |`);
        lines.push(`| Current target head SHA | \`${ps.current.targetHeadSha}\` |`);
        lines.push(
          `| Target code changed since checkpoint | ${ps.comparison.targetCodeChangedSinceCheckpoint ? 'yes' : 'no'} |`,
        );
        lines.push(
          `| Threads/replies changed since checkpoint | ${ps.comparison.threadsChangedSinceCheckpoint != null ? (ps.comparison.threadsChangedSinceCheckpoint ? 'yes' : 'no') : 'unknown'} |`,
        );
        lines.push(
          `| Description changed since checkpoint | ${ps.comparison.descriptionChangedSinceCheckpoint != null ? (ps.comparison.descriptionChangedSinceCheckpoint ? 'yes' : 'no') : 'unknown'} |`,
        );
        lines.push(`| Local HEAD at prepare | \`${ps.current.localHeadSha}\` |`);
        lines.push('| Local checkout verified | yes |');
        lines.push('');

        // Checkpoint-specific context guidance
        if (ps.comparison.targetCodeChangedSinceCheckpoint) {
          lines.push('Target code has changed since the last review checkpoint.');
          lines.push('');
          lines.push('Focus proactive review on the updated diff and unresolved thread updates.');
          lines.push('');
        } else if (ps.comparison.threadsChangedSinceCheckpoint) {
          lines.push(
            'No target code changes since the last review checkpoint, but threads or replies have been updated.',
          );
          lines.push('');
          lines.push(
            'Focus on updated unresolved threads, newly added replies, and pending outputs. Do not perform a full proactive code review unless requested.',
          );
          lines.push('');
        } else {
          lines.push('No target code or thread/reply changes since the last review checkpoint.');
          lines.push('');
          lines.push('Focus on pending outputs, if any. Do not perform a full proactive code review unless requested.');
          lines.push('');
        }
      } else {
        lines.push('No previous revkit review checkpoint was found for this MR/PR.');
        lines.push('');
        lines.push('Treat this as a fresh review.');
        lines.push('');
      }
    }

    // ─── Suggested Reading Order ──────────────────────────
    lines.push('## Suggested Reading Order');
    lines.push('');
    lines.push('1. Read this context file.');
    lines.push('2. Read `.revkit/AGENT_CONTRACT.md`.');
    lines.push('3. Read `.revkit/INSTRUCTIONS.md` as the instruction index.');
    lines.push('4. Read the files listed in **Required Instructions for This Run**.');
    lines.push('5. Read `REVIEW.md` in the repository root if present for project-specific review guidance.');
    lines.push('6. Read relevant unresolved thread files in `.revkit/threads/`.');
    lines.push(
      '7. Use `.revkit/diffs/files.json` to understand which files changed and to locate the relevant per-file patch paths.',
    );
    if (ps?.comparison.targetCodeChangedSinceCheckpoint) {
      lines.push(
        '8. Read `.revkit/diffs/incremental.patch` first to understand what changed since the last checkpoint, then use `.revkit/diffs/latest.patch` for full MR/PR context.',
      );
    } else {
      lines.push('8. Use `.revkit/diffs/latest.patch` for the overall change and cross-file context.');
    }
    lines.push('9. Use `.revkit/diffs/patches/by-file/` for focused review of individual changed files.');
    lines.push(
      '10. Use `.revkit/diffs/line-map.ndjson` to choose and validate review anchors before creating findings.',
    );
    lines.push(
      '11. Use `.revkit/diffs/change-blocks.json` when you need to understand larger insert/delete/replace relationships.',
    );
    lines.push('12. Inspect checked-out source files when needed to understand the new branch state.');
    lines.push('13. Read existing `.revkit/outputs/summary.md`, if present, before updating it.');
    lines.push('');

    // ─── Required Instructions for This Run ───────────────
    const hasUnresolvedThreads = unresolvedThreads.length > 0;
    lines.push('## Required Instructions for This Run');
    lines.push('');
    lines.push('Read these instruction files in order:');
    lines.push('');
    lines.push('1. `.revkit/instructions/01-review-workflow-and-outputs.md`');
    if (hasUnresolvedThreads) {
      lines.push('2. `.revkit/instructions/02-thread-replies.md`');
    } else {
      lines.push('2. ~~`.revkit/instructions/02-thread-replies.md`~~ — skip, no unresolved threads');
    }
    lines.push('3. `.revkit/instructions/03-new-findings-and-anchors.md`');
    lines.push('4. `.revkit/instructions/04-suggestions-and-agent-handover.md`');
    lines.push('5. `.revkit/instructions/05-review-note.md`');
    lines.push('6. `.revkit/instructions/06-summary.md`');
    lines.push('7. `.revkit/instructions/07-final-checks.md`');
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
    lines.push('| `.revkit/AGENT_CONTRACT.md` | Short mandatory review contract |');
    lines.push('| `.revkit/INSTRUCTIONS.md` | Index/router for task-specific instruction files |');
    lines.push('| `.revkit/instructions/` | Detailed task-specific instruction files |');
    lines.push('| `.revkit/bundle.json` | Machine-readable bundle metadata and local state |');
    lines.push('| `.revkit/description.md` | Raw MR/PR description |');
    const threadFileCount = unresolvedThreads.length + generalComments.length;
    if (threadFileCount > 0) {
      lines.push(`| \`.revkit/threads/\` | ${threadFileCount} thread(s) — read the \`.md\` files |`);
    }
    lines.push('| `.revkit/diffs/latest.patch` | Canonical full unified diff for the whole MR/PR |');
    lines.push('| `.revkit/diffs/patches/by-file/` | Canonical per-file unified diffs in standard patch format |');
    lines.push(
      '| `.revkit/diffs/files.json` | Changed-file index with file status, hunk boundaries, counts, binary flag, and diff artifact paths |',
    );
    lines.push('| `.revkit/diffs/line-map.ndjson` | Canonical per-line map for valid positional review anchors |');
    lines.push(
      '| `.revkit/diffs/change-blocks.json` | Grouped insert/delete/replace blocks for understanding larger edits |',
    );
    if (ps?.comparison.targetCodeChangedSinceCheckpoint) {
      lines.push('| `.revkit/diffs/incremental.patch` | Code changes since last review checkpoint |');
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
      lines.push(`| \`${tableCell(d.newPath || d.oldPath)}\` | ${tag} |`);
    }
    lines.push('');

    // ─── Changed Threads Since Checkpoint ────────────────
    const changedThreadIds = options?.changedThreadIds;
    if (changedThreadIds && changedThreadIds.size > 0) {
      const changedThreads = (options?.allThreads ?? threads).filter((t) => changedThreadIds.has(t.threadId));
      const changedUnresolved = changedThreads.filter((t) => !t.resolved);
      const changedResolved = changedThreads.filter((t) => t.resolved);

      if (changedUnresolved.length > 0 || changedResolved.length > 0) {
        lines.push('## Changed Threads Since Last Checkpoint');
        lines.push('');
        lines.push('These threads have been updated since the last review checkpoint. Prioritize reviewing them.');
        lines.push('');
        lines.push('| Thread | Status | Location | Summary |');
        lines.push('|---|---|---|---|');
        for (const t of [...changedUnresolved, ...changedResolved]) {
          const prefix = threadIndex.get(t.threadId) ?? '?';
          const status = t.resolved ? 'resolved' : 'unresolved';
          const file = threadLocation(t);
          const firstComment = firstNonSystemComment(t);
          const snippet = cleanSnippet(firstComment?.body ?? '', 80);
          lines.push(`| ${prefix} | ${status} | ${file} | ${snippet} |`);
        }
        lines.push('');
      }
    }

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

        const firstComment = firstNonSystemComment(t);
        const author = firstComment?.author ?? '?';
        const file = threadLocation(t);
        const snippet = cleanSnippet(firstComment?.body ?? '', 80);
        lines.push(`| ${prefix} | ${flagStr} | @${tableCell(author)} | ${file} | ${snippet} |`);
      }
      lines.push('');
    }

    // ─── General Comments ─────────────────────────────────
    if (generalComments.length > 0) {
      lines.push('## General Comments');
      lines.push('');
      for (const t of generalComments) {
        const prefix = threadIndex.get(t.threadId) ?? '?';
        const firstComment = firstNonSystemComment(t);
        const snippet = cleanSnippet(firstComment?.body ?? '', 120);
        lines.push(`- **${prefix}** (@${tableCell(firstComment?.author ?? '?')}): ${snippet}`);
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
          ? `\`${tableCell(a.location.newPath || a.location.oldPath || '')}\`:${a.location.newLine ?? a.location.oldLine ?? '?'}`
          : tableCell(a.providerThreadId ?? '');
        lines.push(
          `| ${actionLabel} | ${loc} | ${tableCell(a.severity ?? '')} | ${tableCell(a.category ?? '')} | ${tableCell(a.title ?? '')} |`,
        );
      }
      lines.push('');
    }

    const content = lines.join('\n');
    const contextPath = path.join(this.baseDir, 'CONTEXT.md');
    await fs.writeFile(contextPath, content, 'utf-8');

    // Also write instruction files (INSTRUCTIONS.md, AGENT_CONTRACT.md, instructions/*.md)
    await this.writeInstructions();

    return contextPath;
  }

  // ─── Diff bundle artifacts ──────────────────────────────

  /**
   * Parse diffs/latest.patch and write:
   * - diffs/files.json (file index)
   * - diffs/line-map.ndjson (per-line map with explicit nulls)
   * - diffs/change-blocks.json (grouped change blocks)
   * - diffs/patches/by-file/FXXX-Name.patch (per-file unified diffs)
   */
  private async writeDiffBundle(): Promise<void> {
    const patchPath = path.join(this.baseDir, 'diffs', 'latest.patch');
    let patchContent: string;
    try {
      patchContent = await fs.readFile(patchPath, 'utf-8');
    } catch {
      return; // No patch file yet
    }
    const lineMap = parsePatch(patchContent);
    if (lineMap.files.length === 0) return;

    // Assign file IDs
    const filesWithIds = lineMap.files.map((f, idx) => ({
      ...f,
      fileId: `F${String(idx + 1).padStart(3, '0')}`,
    }));

    // Create patches/by-file directory
    const patchesByFileDir = path.join(this.baseDir, 'diffs', 'patches', 'by-file');
    await this.ensureDir(patchesByFileDir);

    // 1. Write files.json
    await this.writeFilesJson(filesWithIds);

    // 2. Write line-map.ndjson
    await this.writeLineMapNdjson(filesWithIds);

    // 3. Write change-blocks.json
    await this.writeChangeBlocks(filesWithIds);

    // 4. Write per-file patch files
    const patchSections = WorkspaceManager.splitPatchByFile(patchContent);
    await this.writePerFilePatchFiles(filesWithIds, patchSections, patchesByFileDir);
  }

  private async writeFilesJson(files: (PatchFileEntry & { fileId: string })[]): Promise<void> {
    const fileIndex = {
      schemaVersion: 1,
      files: files.map((f) => {
        const added = f.lines.filter((l) => l.type === 'added').length;
        const removed = f.lines.filter((l) => l.type === 'removed').length;
        const shortName =
          f.newPath
            .split('/')
            .pop()
            ?.replace(/\.[^.]+$/, '') ?? f.fileId;
        const safeName = shortName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
        return {
          fileId: f.fileId,
          status: f.status,
          binary: f.binary,
          oldExists: f.oldExists,
          newExists: f.newExists,
          oldPath: f.oldPath,
          newPath: f.newPath,
          added,
          removed,
          hunks: f.hunks.map((h) => ({
            hunkId: h.hunkId,
            oldStart: h.oldStart,
            oldEnd: h.oldEnd,
            newStart: h.newStart,
            newEnd: h.newEnd,
          })),
          patchFile: `patches/by-file/${f.fileId}-${safeName}.patch`,
        };
      }),
    };
    await this.writeJson(path.join(this.baseDir, 'diffs', 'files.json'), fileIndex);
  }

  private async writeLineMapNdjson(files: (PatchFileEntry & { fileId: string })[]): Promise<void> {
    const lines: string[] = [];
    for (const file of files) {
      for (const hunk of file.hunks) {
        for (const entry of hunk.lines) {
          lines.push(
            JSON.stringify({
              fileId: file.fileId,
              hunkId: hunk.hunkId,
              kind: entry.type,
              oldLine: entry.oldLine ?? null,
              newLine: entry.newLine ?? null,
              oldPath: file.oldPath,
              newPath: file.newPath,
              text: entry.text,
            }),
          );
        }
      }
    }
    await fs.writeFile(path.join(this.baseDir, 'diffs', 'line-map.ndjson'), lines.join('\n') + '\n', 'utf-8');
  }

  private async writeChangeBlocks(files: (PatchFileEntry & { fileId: string })[]): Promise<void> {
    const blocks: unknown[] = [];
    let blockIndex = 0;

    for (const file of files) {
      for (const hunk of file.hunks) {
        // Group consecutive added/removed lines into blocks
        let i = 0;
        while (i < hunk.lines.length) {
          const entry = hunk.lines[i];
          if (entry.type === 'context') {
            i++;
            continue;
          }

          // Collect contiguous removed + added lines as a potential replace block
          const removedLines: typeof hunk.lines = [];
          const addedLines: typeof hunk.lines = [];

          while (i < hunk.lines.length && hunk.lines[i].type === 'removed') {
            removedLines.push(hunk.lines[i]);
            i++;
          }
          while (i < hunk.lines.length && hunk.lines[i].type === 'added') {
            addedLines.push(hunk.lines[i]);
            i++;
          }

          if (removedLines.length === 0 && addedLines.length === 0) {
            i++;
            continue;
          }

          blockIndex++;
          const blockId = `B${String(blockIndex).padStart(3, '0')}`;
          let kind: 'insert' | 'delete' | 'replace';
          if (removedLines.length > 0 && addedLines.length > 0) {
            kind = 'replace';
          } else if (removedLines.length > 0) {
            kind = 'delete';
          } else {
            kind = 'insert';
          }

          const oldStart = removedLines.length > 0 ? removedLines[0].oldLine! : addedLines[0].newLine! - 1;
          const oldEnd = removedLines.length > 0 ? removedLines[removedLines.length - 1].oldLine! : oldStart;
          const newStart = addedLines.length > 0 ? addedLines[0].newLine! : removedLines[0].oldLine!;
          const newEnd = addedLines.length > 0 ? addedLines[addedLines.length - 1].newLine! : newStart;

          // Determine preferred comment target
          const preferredSide = addedLines.length > 0 ? 'new' : 'old';
          const preferredLine = preferredSide === 'new' ? addedLines[0].newLine! : removedLines[0].oldLine!;
          const preferredPath = preferredSide === 'new' ? file.newPath : file.oldPath;

          blocks.push({
            blockId,
            fileId: file.fileId,
            hunkId: hunk.hunkId,
            kind,
            oldStart,
            oldEnd,
            newStart,
            newEnd,
            preferredCommentTarget: {
              side: preferredSide,
              path: preferredPath,
              line: preferredLine,
            },
          });
        }
      }
    }

    await this.writeJson(path.join(this.baseDir, 'diffs', 'change-blocks.json'), {
      schemaVersion: 1,
      blocks,
    });
  }

  /**
   * Split a multi-file unified diff string into one section per file.
   * Each section begins with the `diff --git` header for that file.
   */
  static splitPatchByFile(patch: string): string[] {
    const sections: string[] = [];
    const lines = patch.split('\n');
    let start = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('diff --git ')) {
        if (start !== -1) {
          sections.push(lines.slice(start, i).join('\n'));
        }
        start = i;
      }
    }

    if (start !== -1) {
      sections.push(lines.slice(start).join('\n'));
    }

    return sections;
  }

  private async writePerFilePatchFiles(
    files: (PatchFileEntry & { fileId: string })[],
    patchSections: string[],
    patchesByFileDir: string,
  ): Promise<void> {
    for (let idx = 0; idx < files.length; idx++) {
      const file = files[idx];
      const shortName =
        file.newPath
          .split('/')
          .pop()
          ?.replace(/\.[^.]+$/, '') ?? file.fileId;
      const safeName = shortName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
      const fileName = `${file.fileId}-${safeName}.patch`;
      const content = patchSections[idx] ?? '';
      await fs.writeFile(path.join(patchesByFileDir, fileName), content.trimEnd() + '\n', 'utf-8');
    }
  }

  /**
   * Ensure default empty output files exist so agents and automation
   * always have a predictable set of files.
   */
  private async ensureDefaultOutputFiles(): Promise<void> {
    const outputDir = path.join(this.baseDir, 'outputs');
    for (const [name, content] of OUTPUT_DEFAULTS) {
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
      await Promise.all(files.map((f) => fs.rm(path.join(threadsDir, f), { recursive: true, force: true })));
    } catch {
      // Directory may not exist yet
    }
  }

  // ─── Write helpers ──────────────────────────────────────

  /**
   * Write INSTRUCTIONS.md, AGENT_CONTRACT.md, and instructions/*.md — copied from the package templates directory.
   */
  async writeInstructions(): Promise<void> {
    const thisFile = fileURLToPath(import.meta.url);
    // dist/workspace/workspace-manager.js -> package root -> templates/
    const templatesDir = path.resolve(path.dirname(thisFile), '..', '..', 'templates');

    // Copy INSTRUCTIONS.md
    const instructionsSource = path.join(templatesDir, 'INSTRUCTIONS.md');
    const instructionsDest = path.join(this.baseDir, 'INSTRUCTIONS.md');
    await fs.copyFile(instructionsSource, instructionsDest);

    // Copy AGENT_CONTRACT.md
    const contractSource = path.join(templatesDir, 'AGENT_CONTRACT.md');
    const contractDest = path.join(this.baseDir, 'AGENT_CONTRACT.md');
    await fs.copyFile(contractSource, contractDest);

    // Copy instructions/*.md
    const instructionsSrcDir = path.join(templatesDir, 'instructions');
    const instructionsDestDir = path.join(this.baseDir, 'instructions');
    await this.ensureDir(instructionsDestDir);
    const entries = await fs.readdir(instructionsSrcDir);
    for (const entry of entries) {
      if (entry.endsWith('.md')) {
        await fs.copyFile(path.join(instructionsSrcDir, entry), path.join(instructionsDestDir, entry));
      }
    }
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
      '# No code changes since last review checkpoint.\n',
      'utf-8',
    );
  }

  private async writeThreads(
    threads: ReviewThread[],
    threadIndex: ThreadIndex,
    diffs: ReviewDiff[],
    currentHeadSha: string,
  ): Promise<void> {
    // Build line map from diffs for embedding diff context in thread files
    const patchContent = diffs.map((d) => WorkspaceManager.diffToGitPatch(d)).join('\n');
    const lineMap = parsePatch(patchContent);

    for (const thread of threads) {
      const prefix = threadIndex.get(thread.threadId);
      if (!prefix) {
        throw new WorkspaceError(`Thread index is missing provider thread ID "${thread.threadId}"`);
      }

      // JSON version — write only the minimal targetRef so agents don't see
      // the full ReviewTarget object (title, description, branches, etc.).
      const threadToWrite = {
        ...thread,
        targetRef: {
          provider: thread.targetRef.provider,
          repository: thread.targetRef.repository,
          targetType: thread.targetRef.targetType,
          targetId: thread.targetRef.targetId,
        },
      };
      await this.writeJson(path.join(this.baseDir, 'threads', `${prefix}.json`), threadToWrite);

      // Markdown version for human/agent reading
      const md = this.threadToMarkdown(thread, prefix, lineMap, currentHeadSha);
      await fs.writeFile(path.join(this.baseDir, 'threads', `${prefix}.md`), md, 'utf-8');
    }
  }

  private async writeDiffs(diffs: ReviewDiff[]): Promise<void> {
    const patchContent = diffs.map((d) => WorkspaceManager.diffToGitPatch(d)).join('\n');
    await fs.writeFile(path.join(this.baseDir, 'diffs', 'latest.patch'), patchContent, 'utf-8');
  }

  async writeIncrementalDiff(diffs: ReviewDiff[]): Promise<void> {
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    const patchContent = diffs.map((d) => WorkspaceManager.diffToGitPatch(d)).join('\n');
    await fs.writeFile(path.join(this.baseDir, 'diffs', 'incremental.patch'), patchContent, 'utf-8');
  }

  /**
   * Build a git-compatible patch text for a single diff, including new/deleted/renamed
   * metadata lines and a Binary files marker for binary new/deleted files.
   */
  static diffToGitPatch(d: ReviewDiff): string {
    let header = `diff --git a/${d.oldPath} b/${d.newPath}`;
    if (d.newFile) {
      header += '\nnew file mode 100644';
    } else if (d.deletedFile) {
      header += '\ndeleted file mode 100644';
    }
    if (d.renamedFile) {
      header += `\nrename from ${d.oldPath}\nrename to ${d.newPath}`;
    }
    const diffContent = d.diff ?? '';
    // For binary new/deleted files the diff field is empty; emit a Binary files
    // marker so the patch parser can detect status and binary flag correctly.
    if (!diffContent.trim() && (d.newFile || d.deletedFile)) {
      const oldRef = d.newFile ? '/dev/null' : `a/${d.oldPath}`;
      const newRef = d.deletedFile ? '/dev/null' : `b/${d.newPath}`;
      header += `\nBinary files ${oldRef} and ${newRef} differ`;
    }
    return `${header}\n${diffContent}`;
  }

  /**
   * Write an incremental diff using git diff between two commit SHAs.
   */
  async writeIncrementalDiffFromGit(git: GitHelper, fromSha: string, toSha: string): Promise<void> {
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    const diffOutput = await git.diff(fromSha, toSha);
    await fs.writeFile(path.join(this.baseDir, 'diffs', 'incremental.patch'), diffOutput, 'utf-8');
  }

  private threadToMarkdown(
    thread: ReviewThread,
    prefix: string,
    lineMap: LineMap | undefined,
    currentHeadSha: string,
  ): string {
    const lines: string[] = [];
    lines.push(`# ${prefix}: Thread ${thread.threadId}`);
    lines.push('');
    lines.push(`- **Status**: ${thread.resolved ? 'Resolved' : 'Unresolved'}`);
    lines.push(`- **Resolvable**: ${thread.resolvable}`);
    if (thread.position) {
      lines.push(`- **File**: \`${thread.position.filePath}\``);
      const lineNum = thread.position?.newLine ?? thread.position?.oldLine;
      if (lineNum) lines.push(`- **Line**: ${lineNum}`);
    }
    lines.push('');

    // Embed diff context around the thread's position.
    // Only show context if the thread's headSha matches the current MR head,
    // otherwise the position may refer to code that no longer exists at those lines.
    if (thread.position && lineMap) {
      const positionMatchesCurrent = !thread.position.headSha || thread.position.headSha === currentHeadSha;
      if (positionMatchesCurrent) {
        const diffSnippet = this.extractDiffContext(thread.position, lineMap);
        if (diffSnippet) {
          lines.push('## Diff Context');
          lines.push('');
          lines.push('```diff');
          lines.push(diffSnippet);
          lines.push('```');
          lines.push('');
        }
      } else {
        lines.push('## Diff Context');
        lines.push('');
        lines.push(
          '> ⚠️ This thread was created on an older revision. The diff context may no longer match the current code.',
        );
        lines.push(`> Thread revision: \`${thread.position.headSha}\` | Current: \`${currentHeadSha}\``);
        lines.push('');
      }
    }

    lines.push('## Comments');
    lines.push('');
    for (const comment of canonicalThreadComments(thread)) {
      if (comment.system) {
        // System events (e.g. "changed this line in version 5", "added commits")
        // These often indicate the MR author pushed changes that may address feedback.
        lines.push('> ℹ️ **System event** — ' + comment.createdAt);
        lines.push('>');
        for (const bodyLine of comment.body.split('\n')) {
          lines.push(`> ${comment.author} ${bodyLine}`);
        }
        lines.push('>');
        lines.push(
          '> *This is informational context only. It may mean the author addressed the thread, but it does not require a reply. Use the current source code when deciding whether the thread is still actionable.*',
        );
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

  /**
   * Extract a few lines of diff context around a thread's position.
   * Shows ~3 lines of context above the referenced line and the line itself,
   * similar to GitLab's inline diff viewer.
   */
  private extractDiffContext(
    position: { filePath: string; newLine?: number; oldLine?: number; newPath?: string; oldPath?: string },
    lineMap: LineMap,
  ): string | null {
    const targetPath = position.newPath || position.filePath;
    const file = lineMap.files.find((f) => f.newPath === targetPath || f.oldPath === targetPath);
    if (!file || file.lines.length === 0) return null;

    const targetLine = position.newLine ?? position.oldLine;
    if (!targetLine) return null;

    // Find the index of the referenced line
    const lineIdx = file.lines.findIndex((l) => {
      if (position.newLine && l.newLine === position.newLine) return true;
      if (position.oldLine && l.oldLine === position.oldLine) return true;
      return false;
    });
    if (lineIdx === -1) return null;

    // Show 3 context lines above and 1 below
    const start = Math.max(0, lineIdx - 3);
    const end = Math.min(file.lines.length - 1, lineIdx + 1);

    const snippetLines: string[] = [];
    for (let i = start; i <= end; i++) {
      const entry = file.lines[i];
      const prefix = entry.type === 'added' ? '+' : entry.type === 'removed' ? '-' : ' ';
      const lineNum = entry.newLine ?? entry.oldLine ?? '';
      const marker = i === lineIdx ? ' ◀' : '';
      snippetLines.push(`${prefix} ${String(lineNum).padStart(4)} | ${entry.text}${marker}`);
    }
    return snippetLines.join('\n');
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new WorkspaceError(
        `Failed to create directory ${dir}: ${err instanceof Error ? err.message : String(err)}`,
      );
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
        enum: [
          'security',
          'correctness',
          'performance',
          'testing',
          'architecture',
          'style',
          'documentation',
          'naming',
          'error-handling',
          'general',
        ],
      },
    },
    anyOf: [{ required: ['oldLine'] }, { required: ['newLine'] }],
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
