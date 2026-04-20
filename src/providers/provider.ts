import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
} from '../core/types.js';

/**
 * Provider-neutral interface for forge operations.
 * Implementations: GitLabProvider, (future) GitHubProvider.
 */
export interface ReviewProvider {
  readonly providerType: 'gitlab' | 'github';

  /** Resolve a human-friendly reference (branch name, MR !123, URL) to a ReviewTargetRef. */
  resolveTarget(ref: string): Promise<ReviewTargetRef>;

  /** List open review targets (MRs/PRs) for the configured repository. */
  listOpenReviewTargets(repo: string): Promise<ReviewTarget[]>;

  /** Fetch full metadata snapshot for a target. */
  getTargetSnapshot(ref: ReviewTargetRef): Promise<ReviewTarget>;

  /** List unresolved threads on a target. */
  listUnresolvedThreads(ref: ReviewTargetRef): Promise<ReviewThread[]>;

  /** List all threads (resolved + unresolved). */
  listAllThreads(ref: ReviewTargetRef): Promise<ReviewThread[]>;

  /** Get the diff for the latest version of the target. */
  getLatestDiff(ref: ReviewTargetRef): Promise<ReviewDiff[]>;

  /** List diff versions (for incremental review). */
  getDiffVersions(ref: ReviewTargetRef): Promise<ReviewVersion[]>;

  /** Get the diff between two versions (incremental diff). */
  getIncrementalDiff(ref: ReviewTargetRef, fromVersion: string, toVersion: string): Promise<ReviewDiff[]>;

  /** Post a reply to a thread. */
  postReply(ref: ReviewTargetRef, threadId: string, body: string): Promise<void>;

  /** Resolve (close) a thread. */
  resolveThread(ref: ReviewTargetRef, threadId: string): Promise<void>;

  /** Update the target description body. */
  updateDescription(ref: ReviewTargetRef, body: string): Promise<void>;
}
