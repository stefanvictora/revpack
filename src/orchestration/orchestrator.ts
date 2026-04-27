import type { ReviewProvider } from '../providers/provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  WorkspaceBundle,
  BundleState,
  NewFinding,
  PrepareSummary,
} from '../core/types.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitHelper } from '../workspace/git-helper.js';

export interface OrchestratorOptions {
  provider: ReviewProvider;
  workingDir: string;
  bundleDirName?: string;
}

export interface PrepareResult {
  bundle: WorkspaceBundle;
  bundleState: BundleState;
  contextPath: string;
  mode: 'fresh' | 'refresh' | 'target_changed';
  codeChanged: boolean | null;
  threadsChanged: boolean | null;
  localBranchStatus?: 'up-to-date' | 'behind' | 'ahead' | 'unknown';
  prunedReplies: number;
  publishedActionCount: number;
}

export interface CheckoutResult {
  branch: string;
  target: ReviewTarget;
  clonedTo?: string;
}

/**
 * Central orchestrator that coordinates provider and workspace into coherent review workflows.
 */
export class ReviewOrchestrator {
  private readonly provider: ReviewProvider;
  readonly workspace: WorkspaceManager;
  private readonly git: GitHelper;

  static readonly COMMENT_MARKER = '<!-- revkit -->';

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
    this.workspace = new WorkspaceManager(options.workingDir, options.bundleDirName);
    this.git = new GitHelper(options.workingDir);
  }

  // ─── High-level workflows ──────────────────────────────

  /**
   * Prepare: the primary workflow.
   * Fetches MR data, generates/refreshes the .revkit/ bundle.
   * Does NOT perform a review or create findings.
   */
  async prepare(
    ref?: string,
    defaultRepo?: string,
    options?: { fresh?: boolean; discardOutputs?: boolean },
  ): Promise<PrepareResult> {
    const existingBundle = await this.workspace.loadBundleState();

    // --fresh: remove everything and start clean
    if (options?.fresh) {
      await this.workspace.removeBundle();
    }

    // Discard outputs if requested
    if (options?.discardOutputs) {
      await this.workspace.discardOutputs();
    }

    const targetRef = await this.resolveRef(ref, defaultRepo);

    // Determine prepare mode
    let mode: PrepareSummary['mode'] = 'fresh';
    const previousBundle = options?.fresh ? null : existingBundle;
    if (previousBundle) {
      if (previousBundle.target.id !== targetRef.targetId) {
        mode = 'target_changed';
      } else {
        mode = 'refresh';
      }
    }

    // Fetch all data in parallel
    const [target, rawThreads, diffs, versions] = await Promise.all([
      this.provider.getTargetSnapshot(targetRef),
      this.provider.listAllThreads(targetRef),
      this.provider.getLatestDiff(targetRef),
      this.provider.getDiffVersions(targetRef),
    ]);

    // Filter out system-only threads
    const allThreads = rawThreads.filter(
      (t) => !t.comments.every((c) => c.system),
    );

    // Build position-based thread index
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);

    // Only non-resolved threads go into the bundle
    const activeThreads = allThreads.filter((t) => !t.resolved);

    // Create the bundle
    const bundle = await this.workspace.createBundle(
      target,
      activeThreads,
      diffs,
      versions,
      threadIndex,
    );

    // Compute prepare summary
    const latestVersionId = versions.length > 0 ? versions[0].versionId : undefined;
    const currentHeadSha = target.diffRefs.headSha;

    const codeChanged = previousBundle && mode === 'refresh'
      ? previousBundle.target.diffRefs.headSha !== currentHeadSha
      : null;

    const threadsChanged = previousBundle && mode === 'refresh'
      ? !arraysEqual(
          previousBundle.threads.knownProviderThreadIds,
          allThreads.map((t) => t.threadId),
        )
      : null;

    const prepareSummary: PrepareSummary = {
      mode,
      previous: previousBundle && mode !== 'fresh' ? {
        preparedAt: previousBundle.preparedAt,
        providerVersionId: previousBundle.target.providerVersionId,
        headSha: previousBundle.target.diffRefs.headSha,
      } : null,
      current: {
        providerVersionId: latestVersionId,
        headSha: currentHeadSha,
      },
      codeChangedSincePreviousPrepare: codeChanged,
      threadsChangedSincePreviousPrepare: threadsChanged,
    };

    // Incremental diff if code changed
    if (codeChanged && previousBundle && versions.length > 0) {
      const latestVersion = versions[0];
      try {
        const incrementalDiffs = await this.provider.getIncrementalDiff(
          targetRef,
          previousBundle.target.providerVersionId!,
          latestVersion.versionId,
        );
        await this.workspace.writeIncrementalDiff(incrementalDiffs);
      } catch {
        // Fall back gracefully
      }
    } else if (mode === 'refresh' && !codeChanged) {
      await this.workspace.writeNoCodeChangeIncrementalPatch();
    }

    // Prune stale replies
    let prunedReplies = 0;
    if (mode === 'refresh') {
      const activeIds = new Set(activeThreads.map((t) => t.threadId));
      prunedReplies = await this.workspace.pruneStaleReplies(activeIds, threadIndex);
    }

    // Carry over published actions from previous bundle
    const previousActions = previousBundle && mode !== 'fresh'
      ? previousBundle.publishedActions
      : [];

    // Write CONTEXT.md
    const contextPath = await this.workspace.writeContext(
      target,
      activeThreads,
      diffs,
      threadIndex,
      { prepareSummary, publishedActions: previousActions },
    );

    // Build and save bundle.json
    const bundleState = this.workspace.buildBundleState(
      target,
      allThreads,
      versions,
      threadIndex,
      prepareSummary,
      previousActions,
    );
    await this.workspace.saveBundleState(bundleState);

    // Check local branch sync status
    let localBranchStatus: PrepareResult['localBranchStatus'] = 'unknown';
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
      // Not a git repo or other error
    }

    return {
      bundle,
      bundleState,
      contextPath,
      mode,
      codeChanged,
      threadsChanged,
      localBranchStatus,
      prunedReplies,
      publishedActionCount: previousActions.length,
    };
  }

  /**
   * Open: resolve ref, fetch snapshot.
   */
  async open(ref?: string, defaultRepo?: string): Promise<ReviewTarget> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    return this.provider.getTargetSnapshot(targetRef);
  }

  /**
   * Check if the current git branch matches the active bundle's target.
   * Returns null if no bundle or no git info available.
   */
  async checkBranchMismatch(): Promise<{ currentBranch: string; expectedBranch: string; targetId: string } | null> {
    const bundleState = await this.workspace.loadBundleState();
    if (!bundleState) return null;
    try {
      const currentBranch = await this.git.currentBranch();
      if (!currentBranch || currentBranch === 'HEAD') return null;
      if (currentBranch !== bundleState.target.sourceBranch) {
        return {
          currentBranch,
          expectedBranch: bundleState.target.sourceBranch,
          targetId: bundleState.target.id,
        };
      }
    } catch {
      // Can't check — not a git repo or API error
    }
    return null;
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
      { oldPath: finding.oldPath, newPath: finding.newPath, newLine: finding.newLine, oldLine: finding.oldLine },
    );
  }

  /** Resolve a T-NNN shorthand to the full thread SHA. */
  async resolveThreadRef(ref: string): Promise<string> {
    return this.workspace.resolveThreadRef(ref);
  }

  /** Review comment marker for finding/updating the synced comment. */
  static readonly REVIEW_COMMENT_MARKER = '<!-- revkit:review-comment -->';

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
    // 1. Explicit ref
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

    // 2. Existing bundle.json
    const bundleState = await this.workspace.loadBundleState();
    if (bundleState) {
      // If we can determine the current branch, check it matches
      try {
        const currentBranch = await this.git.currentBranch();
        if (currentBranch && currentBranch !== 'HEAD' && currentBranch !== bundleState.target.sourceBranch) {
          throw new Error(
            `Branch mismatch: current branch "${currentBranch}" does not match ` +
            `the bundle's MR source branch "${bundleState.target.sourceBranch}" (!${bundleState.target.id}).\n` +
            `Run \`revkit clean\` to remove the stale bundle, or switch to "${bundleState.target.sourceBranch}".`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Branch mismatch')) throw err;
      }
      return {
        provider: bundleState.target.provider,
        repository: bundleState.target.repository,
        targetType: bundleState.target.type,
        targetId: bundleState.target.id,
      };
    }

    // 3. Auto-detect MR from current git branch
    let repo = defaultRepo;
    if (!repo) {
      try { repo = await this.git.deriveRepoSlug(); } catch { /* not a git repo */ }
    }
    if (repo) {
      try {
        const branch = await this.git.currentBranch();
        if (branch && branch !== 'HEAD') {
          const targets = await this.provider.findTargetByBranch(repo, branch);
          if (targets.length === 1) {
            return targets[0];
          }
          if (targets.length > 1) {
            const ids = targets.map((t) => `!${t.targetId}`).join(', ');
            throw new Error(
              `Multiple open MRs found for branch "${branch}": ${ids}\n` +
              'Specify one explicitly: `revkit prepare !<id>`',
            );
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('Multiple open MRs')) throw err;
      }
    }

    throw new Error(
      'Could not determine which MR to prepare.\n' +
      'No ref provided, no existing bundle, and no open MR found for the current branch.\n' +
      'Run `revkit prepare !<id>` to specify one explicitly.',
    );
  }
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((v, i) => v === sortedB[i]);
}
