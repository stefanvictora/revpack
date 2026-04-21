import type { ReviewProvider } from '../providers/provider.js';
import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  WorkspaceBundle,
  Finding,
  ReviewSummary,
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
    options?: { full?: boolean; checkout?: boolean },
  ): Promise<ReviewResult> {
    const targetRef = await this.resolveRef(ref, defaultRepo);

    // Check for existing session (for auto-incremental)
    let existingSession = await this.workspace.loadSession();

    // --full: clear previous session and thread map for a clean start
    if (options?.full && existingSession) {
      await this.workspace.clearSession();
      existingSession = null;
    }

    const isIncremental = !!(existingSession?.lastReviewedVersionId);

    // Optionally checkout the source branch
    if (options?.checkout) {
      const target = await this.provider.getTargetSnapshot(targetRef);
      await this.git.fetch();
      await this.git.checkout(target.sourceBranch);
    }

    // Fetch all data in parallel
    const [target, allThreads, diffs, versions] = await Promise.all([
      this.provider.getTargetSnapshot(targetRef),
      this.provider.listUnresolvedThreads(targetRef),
      this.provider.getLatestDiff(targetRef),
      this.provider.getDiffVersions(targetRef),
    ]);

    const workingDir = this.workspace.bundlePath.replace(/[/\\].review-assist$/, '');

    // Create the bundle
    const bundle = await this.workspace.createBundle(
      target,
      allThreads,
      diffs,
      versions,
      workingDir,
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
    if (isIncremental) {
      const activeIds = new Set(allThreads.map((t) => t.threadId));
      const pruned = await this.workspace.pruneStaleReplies(activeIds);
      if (pruned > 0) {
        // Will be surfaced in the CLI output
      }
    }

    // Classify all threads
    const classifications = allThreads
      .filter((t) => t.resolvable)
      .map((t) => this.classifier.classify(t));

    // Generate findings
    const findings = this.classifyThreads(allThreads, target);

    // Generate summary
    const summary = this.summaryGen.generateSummary(target, diffs, allThreads);
    const summaryMarkdown = this.summaryGen.generateMarkdown(summary);

    // Write outputs
    await this.workspace.writeOutput('summary.json', JSON.stringify(summary, null, 2));
    await this.workspace.writeOutput('summary.md', summaryMarkdown);
    await this.workspace.writeOutput('findings.json', JSON.stringify(findings, null, 2));

    // Write CONTEXT.md — the agent entry point
    const previousThreadIds = isIncremental && existingSession?.knownThreadIds
      ? new Set(existingSession.knownThreadIds)
      : undefined;
    const contextPath = await this.workspace.writeContext(
      target,
      allThreads,
      diffs,
      classifications.map((c) => ({
        threadId: c.threadId,
        severity: c.severity,
        category: c.category,
        summary: c.summary,
      })),
      { incremental: isIncremental, previousThreadIds },
    );

    // Update session with latest version for future incremental runs
    const latestVersionId = versions.length > 0 ? versions[0].versionId : undefined;
    await this.workspace.saveSession({
      id: bundle.sessionId,
      createdAt: bundle.createdAt,
      targetRef,
      bundlePath: this.workspace.bundlePath,
      lastReviewedVersionId: latestVersionId,
      knownThreadIds: allThreads.map((t) => t.threadId),
    });

    return {
      bundle,
      summary,
      findings,
      classifications,
      contextPath,
      summaryMarkdown,
      incremental: isIncremental,
    };
  }

  /**
   * Open: resolve ref, fetch snapshot, display summary info.
   */
  async open(ref?: string, defaultRepo?: string): Promise<ReviewTarget> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    return this.provider.getTargetSnapshot(targetRef);
  }

  /**
   * Threads: list unresolved threads with classification.
   */
  async threads(
    ref?: string,
    defaultRepo?: string,
    options?: { all?: boolean },
  ): Promise<{ threads: ReviewThread[]; classifications: ReturnType<ThreadClassifier['classify']>[] }> {
    const targetRef = await this.resolveRef(ref, defaultRepo);
    const threads = options?.all
      ? await this.provider.listAllThreads(targetRef)
      : await this.provider.listUnresolvedThreads(targetRef);

    const classifications = threads
      .filter((t) => t.resolvable)
      .map((t) => this.classifier.classify(t));

    return { threads, classifications };
  }

  /**
   * Prepare: create workspace bundle with full context for agent consumption.
   */
  async prepare(
    ref?: string,
    defaultRepo?: string,
    options?: { threadIds?: string[]; checkout?: boolean },
  ): Promise<WorkspaceBundle> {
    const targetRef = await this.resolveRef(ref, defaultRepo);

    // Optionally checkout the source branch
    if (options?.checkout) {
      const target = await this.provider.getTargetSnapshot(targetRef);
      await this.git.fetch();
      await this.git.checkout(target.sourceBranch);
    }

    // Fetch all data in parallel
    const [target, allThreads, diffs, versions] = await Promise.all([
      this.provider.getTargetSnapshot(targetRef),
      this.provider.listUnresolvedThreads(targetRef),
      this.provider.getLatestDiff(targetRef),
      this.provider.getDiffVersions(targetRef),
    ]);

    // Filter threads if specific IDs requested
    const threads = options?.threadIds
      ? allThreads.filter((t) => options.threadIds!.includes(t.threadId))
      : allThreads;

    const workingDir = this.workspace.bundlePath.replace(/[/\\].review-assist$/, '');
    const bundle = await this.workspace.createBundle(
      target,
      threads,
      diffs,
      versions,
      workingDir,
    );

    return bundle;
  }

  /**
   * Summarize: generate walkthrough, summary, and changed files table.
   */
  async summarize(
    ref?: string,
    defaultRepo?: string,
  ): Promise<{ summary: ReviewSummary; markdown: string }> {
    const targetRef = await this.resolveRef(ref, defaultRepo);

    const [target, threads, diffs] = await Promise.all([
      this.provider.getTargetSnapshot(targetRef),
      this.provider.listAllThreads(targetRef),
      this.provider.getLatestDiff(targetRef),
    ]);

    const summary = this.summaryGen.generateSummary(target, diffs, threads);
    const markdown = this.summaryGen.generateMarkdown(summary);

    // Write outputs
    await this.workspace.writeOutput('summary.json', JSON.stringify(summary, null, 2));
    await this.workspace.writeOutput('summary.md', markdown);

    return { summary, markdown };
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

  /** Resolve a T-NNN shorthand to the full thread SHA. */
  resolveThreadRef(ref: string): Promise<string> {
    return this.workspace.resolveThreadRef(ref);
  }

  // ─── Helpers ────────────────────────────────────────────

  private async resolveRef(ref?: string, defaultRepo?: string): Promise<ReviewTargetRef> {
    // If no ref given, load the active session
    if (!ref) {
      const session = await this.workspace.loadSession();
      if (!session) {
        throw new Error(
          'No MR/PR reference provided and no active session found in .review-assist/.\n' +
          'Run `review-assist review <ref>` first, or pass a ref explicitly.',
        );
      }
      return session.targetRef;
    }

    const targetRef = await this.provider.resolveTarget(ref);

    // Fill in repository from default or git remote if not present in ref
    if (!targetRef.repository && defaultRepo) {
      targetRef.repository = defaultRepo;
    }
    if (!targetRef.repository) {
      targetRef.repository = await this.git.deriveRepoSlug();
    }

    return targetRef;
  }
}
