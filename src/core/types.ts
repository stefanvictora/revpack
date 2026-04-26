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
export type ReplyDisposition =
  | 'already_fixed'
  | 'explain'
  | 'suggest_fix'
  | 'disagree'
  | 'escalate';

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

export interface WorkspaceBundle {
  sessionId: string;
  createdAt: string;
  target: ReviewTarget;
  threads: ReviewThread[];
  diffs: ReviewDiff[];
  versions: ReviewVersion[];
  outputDir: string;
}

// ─── Session ─────────────────────────────────────────────

export type PublishedActionType = 'reply' | 'finding' | 'resolve';

export interface PublishedAction {
  type: PublishedActionType;
  /** T-NNN short ID (for replies/resolves) or created thread ID (for findings). */
  threadId: string;
  /** For findings: the file path and line that was published. */
  filePath?: string;
  line?: number;
  /** Short description (truncated body or severity+category). */
  detail: string;
  /** When the action was published. */
  publishedAt: string;
  /** For findings: the thread SHA returned by the provider after creation. */
  createdThreadId?: string;
}

export interface Session {
  id: string;
  createdAt: string;
  targetRef: ReviewTargetRef;
  bundlePath: string;
  lastReviewedVersionId?: string;
  /** Thread SHAs seen in the last review run (for tracking new vs. carried-over threads). */
  knownThreadIds?: string[];
  /** Actions published via CLI since this session started. */
  publishedActions?: PublishedAction[];
}
