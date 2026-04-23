import type { ReviewProvider } from '../providers/provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  WorkspaceBundle,
  NewFinding,
} from '../core/types.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitHelper } from '../workspace/git-helper.js';

export interface OrchestratorOptions {
  provider: ReviewProvider;
  workingDir: string;
  bundleDirName?: string;
}

export interface ReviewResult {
  bundle: WorkspaceBundle;
  contextPath: string;
  incremental: boolean;
  /** Whether the local branch HEAD matches the MR head commit. */
  localBranchStatus?: 'up-to-date' | 'behind' | 'ahead' | 'unknown';
  /** Number of replies pruned from stale threads (incremental only). */
  prunedReplies: number;
  /** Number of threads resolved since last review (incremental only). */
  resolvedSinceLastReview: number;
  /** Number of new threads since last review (incremental only). */
  newThreadCount: number;
  /** Number of published actions carried over from the session. */
  publishedActionCount: number;
}

export interface CheckoutResult {
  branch: string;
  target: ReviewTarget;
  /** Set when a fresh clone was performed (no existing git repo). */
  clonedTo?: string;
}

/**
 * Central orchestrator that coordinates provider and workspace into coherent review workflows.
 */
export class ReviewOrchestrator {
  private readonly provider: ReviewProvider;
  private readonly workspace: WorkspaceManager;
  private readonly git: GitHelper;

  /** Marker prepended to every comment published by review-assist. */
  static readonly COMMENT_MARKER = '<!-- review-assist -->';

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
    this.workspace = new WorkspaceManager(options.workingDir, options.bundleDirName);
    this.git = new GitHelper(options.workingDir);
  }

  // ─── High-level workflows ──────────────────────────────

  /**
   * Review: the primary unified workflow.
   * Prepare bundle and write CONTEXT.md.
   * Automatically incremental when a previous session exists, unless `full` is set.
   */
  async review(
    ref?: string,
    defaultRepo?: string,
    options?: { full?: boolean },
  ): Promise<ReviewResult> {
    const targetRef = await this.resolveRef(ref, defaultRepo);

    // Check for existing session (for auto-incremental)
    let existingSession = await this.workspace.loadSession();

    // --full: clear previous session for a clean start
    if (options?.full && existingSession) {
      await this.workspace.clearSession();
      existingSession = null;
    }

    const isIncremental = !!(existingSession?.lastReviewedVersionId);

    // Fetch all data in parallel
    const [target, rawThreads, diffs, versions] = await Promise.all([
      this.provider.getTargetSnapshot(targetRef),
      this.provider.listAllThreads(targetRef),
      this.provider.getLatestDiff(targetRef),
      this.provider.getDiffVersions(targetRef),
    ]);

    // Filter out system-only threads (activity log entries like "added 5 commits")
    const allThreads = rawThreads.filter(
      (t) => !t.comments.every((c) => c.system),
    );

    // Build position-based thread index (T-001, T-002, ... from creation order)
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);

    // Only non-resolved threads go into the bundle (both resolvable discussions and general comments)
    const activeThreads = allThreads.filter((t) => !t.resolved);

    // Create the bundle
    const bundle = await this.workspace.createBundle(
      target,
      activeThreads,
      diffs,
      versions,
      threadIndex,
    );

    // Incremental diff if applicable
    if (isIncremental && versions.length > 0) {
      const latestVersion = versions[0];
      try {
        const incrementalDiffs = await this.provider.getIncrementalDiff(
          targetRef,
          existingSession!.lastReviewedVersionId!,
          latestVersion.versionId,
        );
        await this.workspace.writeIncrementalDiff(incrementalDiffs);
      } catch {
        // Fall back gracefully — incremental diff is best-effort
      }
    }

    // Prune stale replies from previous runs (incremental safety)
    let prunedReplies = 0;
    if (isIncremental) {
      const activeIds = new Set(activeThreads.map((t) => t.threadId));
      prunedReplies = await this.workspace.pruneStaleReplies(activeIds, threadIndex);
    }

    // Compute incremental stats
    const previousThreadIdSet = isIncremental && existingSession?.knownThreadIds
      ? new Set(existingSession.knownThreadIds)
      : undefined;

    let resolvedSinceLastReview = 0;
    let newThreadCount = 0;
    if (previousThreadIdSet) {
      resolvedSinceLastReview = [...previousThreadIdSet].filter(
        (id) => !activeThreads.some((t) => t.threadId === id),
      ).length;
      newThreadCount = activeThreads.filter(
        (t) => t.resolvable && !t.resolved && !previousThreadIdSet.has(t.threadId),
      ).length;
    }

    // Write CONTEXT.md — the agent entry point
    const publishedActions = existingSession?.publishedActions ?? [];
    const contextPath = await this.workspace.writeContext(
      target,
      activeThreads,
      diffs,
      threadIndex,
      { incremental: isIncremental, previousThreadIds: previousThreadIdSet, publishedActions },
    );

    // Update session with latest version for future incremental runs
    const latestVersionId = versions.length > 0 ? versions[0].versionId : undefined;
    await this.workspace.saveSession({
      id: bundle.sessionId,
      createdAt: bundle.createdAt,
      targetRef,
      bundlePath: this.workspace.bundlePath,
      lastReviewedVersionId: latestVersionId,
      knownThreadIds: activeThreads.map((t) => t.threadId),
      publishedActions,
    });

    // Check local branch sync status against the MR head commit
    let localBranchStatus: ReviewResult['localBranchStatus'] = 'unknown';
    try {
      const mrHeadSha = target.diffRefs.headSha;
      if (mrHeadSha) {
        const isAtHead = await this.git.isAtCommit(mrHeadSha);
        if (isAtHead) {
          localBranchStatus = 'up-to-date';
        } else {
          const isAncestor = await this.git.isAncestor(mrHeadSha);
          localBranchStatus = isAncestor ? 'ahead' : 'behind';
        }
      }
    } catch {
      // Not a git repo or other error — leave as unknown
    }

    return {
      bundle,
      contextPath,
      incremental: isIncremental,
      localBranchStatus,
      prunedReplies,
      resolvedSinceLastReview,
      newThreadCount,
      publishedActionCount: publishedActions.length,
    };
  }

  /**
   * Status: resolve ref, fetch snapshot, display summary info.
   */
  async open(ref?: string, defaultRepo?: string): Promise<ReviewTarget> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    return this.provider.getTargetSnapshot(targetRef);
  }

  /**
   * Check if the current git branch matches the active session's target.
   * Returns null if no session or no git info available.
   */
  async checkBranchMismatch(): Promise<{ currentBranch: string; expectedBranch: string; targetId: string } | null> {
    const session = await this.workspace.loadSession();
    if (!session) return null;
    try {
      const currentBranch = await this.git.currentBranch();
      if (!currentBranch || currentBranch === 'HEAD') return null;
      const target = await this.provider.getTargetSnapshot(session.targetRef);
      if (currentBranch !== target.sourceBranch) {
        return { currentBranch, expectedBranch: target.sourceBranch, targetId: session.targetRef.targetId };
      }
    } catch {
      // Can't check — not a git repo or API error
    }
    return null;
  }

  /**
   * Reset: clear the active session and optionally the entire bundle.
   */
  async reset(options?: { full?: boolean }): Promise<void> {
    if (options?.full) {
      await this.workspace.removeBundle();
    } else {
      await this.workspace.clearSession();
    }
  }

  /**
   * Checkout: fetch the MR source branch and switch to it.
   * If we're not inside a git repo, performs a shallow clone instead.
   */
  async checkout(ref: string, defaultRepo?: string): Promise<CheckoutResult> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    const target = await this.provider.getTargetSnapshot(targetRef);

    const inRepo = await this.git.isGitRepo();

    if (!inRepo) {
      // No git repo — shallow clone into a sub-directory (like `git clone`)
      const cloneUrl = this.provider.getCloneUrl(targetRef.repository);
      const clonedDir = await GitHelper.clone(
        cloneUrl,
        target.sourceBranch,
        this.git.cwd,
      );
      return { branch: target.sourceBranch, target, clonedTo: clonedDir };
    }

    // Existing repo — require clean tree, then fetch + switch
    const isClean = await this.git.isClean();
    if (!isClean) {
      throw new Error(
        'Working tree has uncommitted changes. Commit or stash them before switching branches.',
      );
    }

    // Fetch the source branch and switch to it
    await this.git.fetchBranch(target.sourceBranch);
    await this.git.switchBranch(target.sourceBranch);

    // Clear any stale session for a different target
    const existingSession = await this.workspace.loadSession();
    if (existingSession && existingSession.targetRef.targetId !== targetRef.targetId) {
      await this.workspace.clearSession();
    }

    return { branch: target.sourceBranch, target };
  }

  // ─── Write operations (guarded) ─────────────────────────

  async publishReply(ref?: string, threadId?: string, body?: string, defaultRepo?: string): Promise<void> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    if (!threadId) throw new Error('threadId is required');
    if (!body) throw new Error('reply body is required');
    const resolvedId = await this.workspace.resolveThreadRef(threadId);
    const markedBody = `${ReviewOrchestrator.COMMENT_MARKER}\n${body}`;
    await this.provider.postReply(targetRef, resolvedId, markedBody);
  }

  async resolveThread(ref?: string, threadId?: string, defaultRepo?: string): Promise<void> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    if (!threadId) throw new Error('threadId is required');
    const resolvedId = await this.workspace.resolveThreadRef(threadId);
    await this.provider.resolveThread(targetRef, resolvedId);
  }

  async updateDescription(ref?: string, body?: string, defaultRepo?: string): Promise<void> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    if (!body) throw new Error('description body is required');
    await this.provider.updateDescription(targetRef, body);
  }

  /**
   * Publish a new finding as a discussion thread on the MR/PR.
   * Returns the created thread ID.
   */
  async publishFinding(finding: NewFinding, defaultRepo?: string): Promise<string> {
    const targetRef = await this.resolveRef(undefined, defaultRepo);
    const markedBody = `${ReviewOrchestrator.COMMENT_MARKER}\n${finding.body}`;
    return this.provider.createThread(
      targetRef,
      markedBody,
      { filePath: finding.filePath, newLine: finding.newLine, oldLine: finding.oldLine },
    );
  }

  /** Resolve a T-NNN shorthand to the full thread SHA. */
  async resolveThreadRef(ref: string): Promise<string> {
    return this.workspace.resolveThreadRef(ref);
  }

  /** Review comment marker for finding/updating the synced comment. */
  static readonly REVIEW_COMMENT_MARKER = '<!-- review-assist:review-comment -->';

  /**
   * Create or update the synced review comment on the MR/PR.
   * This is a standalone note (not a discussion thread) that gets
   * updated in-place on each sync.
   */
  async syncReviewComment(body: string, defaultRepo?: string): Promise<{ created: boolean }> {
    const targetRef = await this.resolveRef(undefined, defaultRepo);
    const marker = ReviewOrchestrator.REVIEW_COMMENT_MARKER;
    const fullBody = `${marker}\n${body}`;

    const existingNoteId = await this.provider.findNoteByMarker(targetRef, marker);
    if (existingNoteId) {
      await this.provider.updateNote(targetRef, existingNoteId, fullBody);
      return { created: false };
    } else {
      await this.provider.createNote(targetRef, fullBody);
      return { created: true };
    }
  }

  // ─── Helpers ────────────────────────────────────────────

  private async resolveRef(ref?: string, defaultRepo?: string): Promise<ReviewTargetRef> {
    // 1. Explicit ref provided — parse it
    if (ref) {
      const targetRef = await this.provider.resolveTarget(ref);

      if (!targetRef.repository && defaultRepo) {
        targetRef.repository = defaultRepo;
      }
      if (!targetRef.repository) {
        targetRef.repository = await this.git.deriveRepoSlug();
      }

      return targetRef;
    }

    // 2. Existing session — but validate branch match first
    const session = await this.workspace.loadSession();
    if (session) {
      // If we can determine the current branch, check it matches the session's target
      try {
        const currentBranch = await this.git.currentBranch();
        const target = await this.provider.getTargetSnapshot(session.targetRef);
        if (currentBranch && currentBranch !== 'HEAD' && currentBranch !== target.sourceBranch) {
          throw new Error(
            `Branch mismatch: current branch "${currentBranch}" does not match ` +
            `the session's MR source branch "${target.sourceBranch}" (!${session.targetRef.targetId}).\n` +
            `Run \`review-assist reset\` to clear the stale session, or switch to "${target.sourceBranch}".`,
          );
        }
      } catch (err) {
        // Re-throw branch mismatch errors; ignore git failures (not a repo, etc.)
        if (err instanceof Error && err.message.includes('Branch mismatch')) throw err;
      }
      return session.targetRef;
    }

    // 3. Auto-detect MR from current git branch
    let repo = defaultRepo;
    if (!repo) {
      try { repo = await this.git.deriveRepoSlug(); } catch { /* not a git repo */ }
    }
    if (repo) {
      try {
        const branch = await this.git.currentBranch();
        if (branch && branch !== 'HEAD') { // HEAD means detached
          const targets = await this.provider.findTargetByBranch(repo, branch);
          if (targets.length === 1) {
            return targets[0]; // ReviewTarget extends ReviewTargetRef
          }
          if (targets.length > 1) {
            const ids = targets.map((t) => `!${t.targetId}`).join(', ');
            throw new Error(
              `Multiple open MRs found for branch "${branch}": ${ids}\n` +
              'Specify one explicitly: `review-assist review !<id>`',
            );
          }
        }
      } catch (err) {
        // If it's our "multiple MRs" error, re-throw; otherwise fall through
        if (err instanceof Error && err.message.includes('Multiple open MRs')) throw err;
      }
    }

    throw new Error(
      'Could not determine which MR to review.\n' +
      'No ref provided, no active session, and no open MR found for the current branch.\n' +
      'Run `review-assist review !<id>` to specify one explicitly.',
    );
  }
}
