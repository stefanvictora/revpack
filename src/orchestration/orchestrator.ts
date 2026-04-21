import type { ReviewProvider } from '../providers/provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  WorkspaceBundle,
  Finding,
  ReviewSummary,
  NewFinding,
} from '../core/types.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import { GitHelper } from '../workspace/git-helper.js';
import { ThreadClassifier } from './thread-classifier.js';
import { SummaryGenerator } from './summary-generator.js';

export interface OrchestratorOptions {
  provider: ReviewProvider;
  workingDir: string;
  bundleDirName?: string;
}

export interface ReviewResult {
  bundle: WorkspaceBundle;
  summary: ReviewSummary;
  findings: Finding[];
  classifications: ReturnType<ThreadClassifier['classify']>[];
  contextPath: string;
  summaryMarkdown: string;
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

/**
 * Central orchestrator that coordinates provider, workspace, and
 * classification into coherent review workflows.
 */
export class ReviewOrchestrator {
  private readonly provider: ReviewProvider;
  private readonly workspace: WorkspaceManager;
  private readonly git: GitHelper;
  private readonly classifier: ThreadClassifier;
  private readonly summaryGen: SummaryGenerator;

  constructor(options: OrchestratorOptions) {
    this.provider = options.provider;
    this.workspace = new WorkspaceManager(options.workingDir, options.bundleDirName);
    this.git = new GitHelper(options.workingDir);
    this.classifier = new ThreadClassifier();
    this.summaryGen = new SummaryGenerator();
  }

  // ─── High-level workflows ──────────────────────────────

  /**
   * Review: the primary unified workflow.
   * Prepare bundle + classify threads + generate summary + write CONTEXT.md.
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

    // Classify resolvable unresolved threads
    const classifications = activeThreads
      .filter((t) => t.resolvable)
      .map((t) => this.classifier.classify(t));

    // Generate findings
    const findings = this.classifyThreads(activeThreads, target);

    // Generate summary
    const summary = this.summaryGen.generateSummary(target, diffs, activeThreads);
    const summaryMarkdown = this.summaryGen.generateMarkdown(summary);

    // Write outputs
    await this.workspace.writeOutput('summary.json', JSON.stringify(summary, null, 2));
    await this.workspace.writeOutput('summary.md', summaryMarkdown);
    await this.workspace.writeOutput('findings.json', JSON.stringify(findings, null, 2));

    // Write CONTEXT.md — the agent entry point
    const publishedActions = existingSession?.publishedActions ?? [];
    const contextPath = await this.workspace.writeContext(
      target,
      activeThreads,
      diffs,
      classifications.map((c) => ({
        threadId: c.threadId,
        severity: c.severity,
        category: c.category,
        summary: c.summary,
      })),
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
      summary,
      findings,
      classifications,
      contextPath,
      summaryMarkdown,
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
   * Classify threads and produce findings (without LLM — heuristic only).
   */
  classifyThreads(threads: ReviewThread[], target: ReviewTarget): Finding[] {
    return threads
      .filter((t) => t.resolvable && !t.resolved)
      .map((thread) => {
        const classification = this.classifier.classify(thread);
        const firstComment = thread.comments.find((c) => !c.system);

        const finding: Finding = {
          type: 'finding',
          provider: target.provider,
          repository: target.repository,
          targetType: target.targetType,
          targetId: target.targetId,
          threadId: thread.threadId,
          commentId: firstComment?.id ?? '',
          origin: classification.origin,
          severity: classification.severity,
          confidence: classification.confidence,
          category: classification.category,
          status: 'unreviewed',
          disposition: 'explain_only',
          fileName: thread.position?.filePath ?? '',
          lineStart: thread.position?.newLine,
          lineEnd: thread.position?.newLine,
          title: classification.summary,
          problem: firstComment?.body ?? '',
          validationSummary: '',
          suggestions: [],
          replyDraft: '',
          checks: { build: 'not_run', tests: 'not_run', lint: 'not_run' },
        };

        return finding;
      });
  }

  // ─── Write operations (guarded) ─────────────────────────

  async publishReply(ref?: string, threadId?: string, body?: string, defaultRepo?: string): Promise<void> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    if (!threadId) throw new Error('threadId is required');
    if (!body) throw new Error('reply body is required');
    const resolvedId = await this.workspace.resolveThreadRef(threadId);
    await this.provider.postReply(targetRef, resolvedId, body);
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
    return this.provider.createThread(
      targetRef,
      finding.body,
      { filePath: finding.filePath, newLine: finding.line },
    );
  }

  /** Resolve a T-NNN shorthand to the full thread SHA. */
  async resolveThreadRef(ref: string): Promise<string> {
    return this.workspace.resolveThreadRef(ref);
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

    // 2. Existing session — resume from it
    const session = await this.workspace.loadSession();
    if (session) {
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
