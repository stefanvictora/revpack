import type {
  ReviewTarget,
  ReviewTargetRef,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
} from '../core/types.js';

/**
 * Position for creating a new discussion thread on a diff.
 */
export interface NewThreadPosition {
  /** File path (new_path in the diff). */
  filePath: string;
  /** Line number in the new version of the file. */
  newLine: number;
  /** Optional: line in the old version (for removed lines). */
  oldLine?: number;
}

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

  /** Find open MR/PR(s) for a given source branch name. */
  findTargetByBranch(repo: string, branchName: string): Promise<ReviewTarget[]>;

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

  /** Create a new discussion thread on the MR/PR diff. */
  createThread(ref: ReviewTargetRef, body: string, position?: NewThreadPosition): Promise<string>;

  /**
   * Find an existing MR/PR note whose body starts with the given marker.
   * Returns the note ID if found, null otherwise.
   */
  findNoteByMarker(ref: ReviewTargetRef, marker: string): Promise<string | null>;

  /** Create a standalone note (not a discussion thread) on the MR/PR. */
  createNote(ref: ReviewTargetRef, body: string): Promise<string>;

  /** Update an existing standalone note on the MR/PR. */
  updateNote(ref: ReviewTargetRef, noteId: string, body: string): Promise<void>;

  /** Get the HTTPS clone URL for a repository. */
  getCloneUrl(repo: string): string;
}
