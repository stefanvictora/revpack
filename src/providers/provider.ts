import type { ReviewTarget, ReviewTargetRef, ReviewThread, ReviewVersion } from '../core/types.js';

/**
 * Position for creating a new discussion thread on a diff.
 */
export interface NewThreadPosition {
  /** Path in the old (base) version of the diff. */
  oldPath: string;
  /** Path in the new (head) version of the diff. */
  newPath: string;
  /** Line number in the new version of the file (for added/context lines). */
  newLine?: number;
  /** Line number in the old version of the file (for removed/context lines). */
  oldLine?: number;
}

export interface CheckoutFallbackRef {
  /** Remote ref to fetch from the base repository, such as a provider-owned PR/MR head ref. */
  remoteRef: string;
  /** Local branch to create from the fetched fallback ref. */
  localBranch: string;
}

export interface CheckoutBranchTarget {
  provider: string;
  targetType?: string;
  type?: string;
  targetId?: string;
  id?: string;
  sourceBranch: string;
}

/**
 * Provider-neutral interface for forge operations.
 * Implementations: GitLabProvider, (future) GitHubProvider.
 */
export interface ReviewProvider {
  readonly providerType: 'gitlab' | 'github' | 'local';

  /** Resolve a human-friendly reference (branch name, MR !123, URL) to a ReviewTargetRef. */
  resolveTarget(ref: string): ReviewTargetRef;

  /** List open review targets (MRs/PRs) for the configured repository. */
  listOpenReviewTargets(repo: string): Promise<ReviewTarget[]>;

  /** Find open MR/PR(s) for a given source branch name. */
  findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]>;

  /** Fetch full metadata snapshot for a target. */
  getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget>;

  /** List unresolved threads on a target. */
  listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]>;

  /** List all threads (resolved + unresolved). */
  listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]>;

  /** List diff versions (for incremental review). */
  getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]>;

  /** Post a reply to a thread. */
  postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void>;

  /** Resolve (close) a thread. */
  resolveThread(ref: ReviewTargetRef, threadId: string): Promise<void>;

  /** Update the target description body. */
  updateDescription(ref: ReviewTargetRef, body: string): Promise<void>;

  /** Create a new discussion thread on the MR/PR diff. */
  createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string>;

  /**
   * Find an existing MR/PR note whose body starts with the given marker.
   * Returns the note ID and body if found, null otherwise.
   */
  findNoteByMarker(ref: ReviewTargetRef, marker: string): Promise<{ id: string; body: string } | null>;

  /** Create a standalone note (not a discussion thread) on the MR/PR. */
  createNote(ref: ReviewTargetRef, body: string, options?: { internal?: boolean }): Promise<string>;

  /** Update an existing standalone note on the MR/PR. */
  updateNote(ref: ReviewTargetRef, noteId: string, body: string): Promise<void>;

  /** Get the HTTPS clone URL for a repository. */
  getCloneUrl(repo: string): string;

  /**
   * Return the git refspec that can be fetched from the base repository to get the
   * PR/MR head, e.g. `refs/pull/42/head` for GitHub.
   * When defined, the orchestrator uses this instead of branch-based fetch/clone so
   * that checkout works even when the source branch has been deleted from the fork.
   * Providers that do not support permanent PR refspecs may omit this method.
   */
  getSourceRefspec?(ref: ReviewTargetRef): string;

  /**
   * Return a provider-specific checkout fallback for cases where fetching the
   * source branch failed. Unlike getSourceRefspec, this is not necessarily
   * permanent or preferred over the branch path.
   */
  getCheckoutFallbackRef?(ref: ReviewTargetRef): CheckoutFallbackRef | null;

  /** Return the local fallback branch name for branch consistency checks. */
  getCheckoutFallbackBranch?(target: CheckoutBranchTarget): string | null;

  /** Format a provider-specific error when source branch and fallback checkout both fail. */
  formatCheckoutFallbackError?(target: ReviewTarget, sourceError: unknown, fallbackError: unknown): Error;

  /**
   * Submit a pull request review batch with inline comments and optional body.
   * Only supported by GitHub. GitLab providers should not implement this.
   */
  submitReview?(
    ref: ReviewTargetRef,
    comments: Array<{ body: string; path: string; line?: number; side?: 'LEFT' | 'RIGHT' }>,
    body: string,
    event: 'COMMENT' | 'APPROVE' | 'REQUEST_CHANGES',
  ): Promise<void>;
}
