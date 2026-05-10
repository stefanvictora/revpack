// Core domain types — provider-neutral review concepts.

// ─── Enums ───────────────────────────────────────────────

export type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'nit';
export type FindingCategory =
  | 'security'
  | 'correctness'
  | 'performance'
  | 'testing'
  | 'architecture'
  | 'style'
  | 'documentation'
  | 'naming'
  | 'error-handling'
  | 'general';
export type Confidence = 'high' | 'medium' | 'low';
export type CommentOrigin = 'human' | 'bot' | 'unknown';
export type ProviderType = 'gitlab' | 'github';
export type TargetType = 'merge_request' | 'pull_request';
export type LearningScope = 'org' | 'repository' | 'path' | 'file';
export type LearningRuleType = 'review_preference' | 'architecture_rule' | 'testing_rule' | 'false_positive_pattern';
export type ApprovalState = 'pending' | 'approved' | 'rejected';

// ─── Review Target ───────────────────────────────────────

export interface ReviewTargetRef {
  provider: ProviderType;
  repository: string;
  targetType: TargetType;
  targetId: string;
}

export interface ReviewTarget extends ReviewTargetRef {
  title: string;
  description: string;
  author: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  diffRefs: DiffRefs;
  /**
   * For fork-based PRs: the `owner/repo` slug of the contributor's fork.
   * Undefined for same-repository PRs.
   * Used by checkout to clone/fetch from the correct upstream.
   */
  headRepository?: string;
}

export interface DiffRefs {
  baseSha: string;
  headSha: string;
  startSha: string;
}

// ─── Review Version ──────────────────────────────────────

export interface ReviewVersionRef {
  provider: ProviderType;
  targetRef: ReviewTargetRef;
  versionId: string;
}

export interface ReviewVersion extends ReviewVersionRef {
  headCommitSha: string;
  baseCommitSha: string;
  startCommitSha: string;
  createdAt: string;
  realSize: number;
}

// ─── Review Diff ─────────────────────────────────────────

export interface ReviewDiff {
  oldPath: string;
  newPath: string;
  diff: string;
  newFile: boolean;
  renamedFile: boolean;
  deletedFile: boolean;
}

// ─── Review Thread & Comment ─────────────────────────────

export interface DiffPosition {
  filePath: string;
  oldLine?: number;
  newLine?: number;
  oldPath?: string;
  newPath?: string;
  baseSha?: string;
  headSha?: string;
  startSha?: string;
}

export interface ReviewComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  origin: CommentOrigin;
  system: boolean;
}

export interface ReviewThreadRef {
  provider: ProviderType;
  targetRef: ReviewTargetRef;
  threadId: string;
}

export interface ReviewThread extends ReviewThreadRef {
  resolved: boolean;
  resolvable: boolean;
  resolvedBy?: string;
  resolvedAt?: string;
  position?: DiffPosition;
  comments: ReviewComment[];
}

// ─── Patch Proposal ──────────────────────────────────────

export interface PatchProposal {
  threadId: string;
  filePath: string;
  diff: string;
  description: string;
  createdAt: string;
}

// ─── Learning ────────────────────────────────────────────

export interface Learning {
  id: string;
  scope: LearningScope;
  providerScope?: string;
  ruleType: LearningRuleType;
  statement: string;
  createdFrom: string;
  createdBy: string;
  approvalState: ApprovalState;
  usageCount: number;
  lastUsedAt?: string;
  active: boolean;
}

// ─── New Finding (agent-generated) ───────────────────────

/**
 * A new finding created by an agent during proactive code review.
 * Written to outputs/new-findings.json for publishing via `publish findings`.
 */
export interface NewFinding {
  /** Path in the old (base) version of the diff. For non-renamed files, same as newPath. */
  oldPath: string;
  /** Path in the new (head) version of the diff. For non-renamed files, same as oldPath. */
  newPath: string;
  /** Line number in the new version of the file (right side of the diff). Set for added/context lines. */
  newLine?: number;
  /** Line number in the old version of the file (left side of the diff). Set for removed/context lines. */
  oldLine?: number;
  /** The review comment body (markdown). */
  body: string;
  /** Severity for prioritization. */
  severity: Severity;
  /** Category tag. */
  category: FindingCategory;
}

/**
 * Reply disposition (internal tracking, not published to GitLab).
 */
export type ReplyDisposition = 'already_fixed' | 'explain' | 'suggest_fix' | 'disagree' | 'escalate';

/**
 * A reply to an existing thread, written to outputs/replies.json.
 */
export interface ReplyDraft {
  threadId: string;
  body: string;
  resolve: boolean;
  disposition?: ReplyDisposition;
}

// ─── Workspace Bundle ────────────────────────────────────

/** The on-disk bundle.json — canonical machine-readable state. */
export interface BundleState {
  schemaVersion: number;
  preparedAt: string;
  tool: { name: string; version: string };
  target: BundleTarget;
  local: BundleLocal;
  prepare: PrepareSummary;
  threads: BundleThreads;
  outputs: BundleOutputs;
  publishedActions: BundlePublishedAction[];
  paths: BundlePaths;
}

export interface BundleLocal {
  repositoryRoot: string;
  branch: string;
  headSha: string;
  matchesTargetSourceBranch: boolean;
  matchesTargetHead: boolean;
  workingTreeClean: boolean;
  checkedAt: string;
}

export interface BundleTarget {
  provider: ProviderType;
  repository: string;
  type: TargetType;
  id: string;
  title: string;
  descriptionPath: string;
  author: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  webUrl: string;
  createdAt: string;
  updatedAt: string;
  labels: string[];
  diffRefs: DiffRefs;
  providerVersionId?: string;
}

export interface PrepareSummary {
  mode: 'fresh' | 'refresh' | 'target_changed';
  checkpoint: RemoteCheckpoint | null;
  current: {
    providerVersionId?: string;
    targetHeadSha: string;
    localHeadSha: string;
    threadsDigest: string | null;
    descriptionDigest?: string | null;
  };
  comparison: BundleComparison;
}

/** Remote checkpoint parsed from the MR/PR description body. */
export interface RemoteCheckpoint {
  source: 'description_body';
  providerNoteId: string;
  headSha: string;
  baseSha: string;
  startSha: string;
  providerVersionId?: string;
  threadsDigest: string | null;
  descriptionDigest?: string | null;
  /** Per-thread digests at checkpoint time, keyed by provider thread ID. */
  threadDigests: Record<string, string>;
  createdAt: string;
}

export interface BundleComparison {
  targetCodeChangedSinceCheckpoint: boolean | null;
  threadsChangedSinceCheckpoint: boolean | null;
  descriptionChangedSinceCheckpoint: boolean | null;
}

export interface BundleThreads {
  digestVersion: number;
  digest: string | null;
  items: BundleThreadItem[];
}

export interface BundleThreadItem {
  shortId: string;
  providerThreadId: string;
  file: string;
  markdownFile: string;
  resolved: boolean;
  resolvable: boolean;
  commentsCount: number;
  latestCommentAt: string | null;
  digest: string;
}

export type OutputState = 'empty' | 'pending' | 'published' | 'modified since publish';

export interface BundleOutputEntry {
  path: string;
  lastPublishedHash?: string;
  lastPublishedAt?: string;
  lastPublishedTargetHeadSha?: string;
  providerNoteId?: string;
}

export interface BundleOutputs {
  summary: BundleOutputEntry;
  review: BundleOutputEntry;
}

export interface BundlePublishedAction {
  type: PublishedActionType;
  providerThreadId?: string;
  location?: {
    oldPath?: string;
    newPath?: string;
    oldLine?: number;
    newLine?: number;
  };
  severity?: string;
  category?: string;
  title?: string;
  publishedAt: string;
}

export interface BundlePaths {
  context: string;
  instructions: string;
  description: string;
  latestPatch: string;
  incrementalPatch: string | null;
  filesJson: string;
  lineMapNdjson: string;
  changeBlocks: string;
  annotatedDiff: string;
  outputs: string;
}

/** In-memory bundle used during prepare (not persisted directly). */
export interface WorkspaceBundle {
  preparedAt: string;
  target: ReviewTarget;
  threads: ReviewThread[];
  diffs: ReviewDiff[];
  versions: ReviewVersion[];
  bundlePath: string;
  outputDir: string;
}

export type PublishedActionType = 'reply' | 'finding' | 'resolve';
