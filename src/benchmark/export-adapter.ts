import * as path from 'node:path';
import * as fs from 'node:fs';
import type { BundleState, NewFinding } from '../core/types.js';

// ─── Types ───────────────────────────────────────────────

export interface GitHubPullIdentity {
  owner: string;
  repo: string;
  number: number;
  /** e.g. "owner/repo#123" — used as the benchmark index key */
  key: string;
  /** human-readable label, same as key */
  label: string;
}

export interface BenchmarkReviewComment {
  path: string | null;
  line: number;
  body: string;
  created_at: string;
}

export interface BenchmarkReview {
  tool: string;
  repo_name: string;
  pr_url: string;
  review_comments: BenchmarkReviewComment[];
}

export interface BenchmarkPrEntry {
  reviews: BenchmarkReview[];
  [key: string]: unknown;
}

export type BenchmarkData = Record<string, BenchmarkPrEntry>;

export interface IndexedBenchmarkEntry {
  canonicalPrUrl: string;
  value: BenchmarkPrEntry;
}

export interface PreparedWorkspace {
  root: string;
}

export interface ExportCandidate {
  type: 'export';
  workspace: PreparedWorkspace;
  bundle: BundleState;
  identity: GitHubPullIdentity;
  benchmarkEntry: IndexedBenchmarkEntry;
  findingsPath: string;
}

export interface Skip {
  type: 'skip';
  workspace: PreparedWorkspace;
  reason: string;
}

// ─── Tool slugging ───────────────────────────────────────

/**
 * Convert a tool name to a URL/filename-safe slug.
 * Lowercases, replaces runs of non-alphanumeric chars with '-', trims edges.
 */
export function slugifyToolName(tool: string): string {
  return tool
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─── GitHub PR URL parsing ───────────────────────────────

/**
 * Parse a GitHub pull request URL into its identity components.
 * Tolerates trailing slashes.
 * @throws if the URL is not a valid GitHub PR URL
 */
export function parseGitHubPullUrl(url: string): GitHubPullIdentity {
  const trimmed = url.replace(/\/+$/, '');
  let urlObj: URL;
  try {
    urlObj = new URL(trimmed);
  } catch {
    throw new Error(`Cannot parse as URL: ${url}`);
  }
  const parts = urlObj.pathname.split('/').filter(Boolean);
  // Expected parts: [owner, repo, 'pull', number]
  if (urlObj.hostname !== 'github.com' || parts.length < 4 || parts[2] !== 'pull') {
    throw new Error(`Not a valid GitHub pull request URL: ${url}`);
  }
  const owner = parts[0];
  const repo = parts[1];
  const number = parseInt(parts[3], 10);
  if (!Number.isFinite(number) || number <= 0) {
    throw new Error(`Invalid PR number in GitHub URL: ${url}`);
  }
  const key = `${owner}/${repo}#${number}`;
  return { owner, repo, number, key, label: key };
}

// ─── Output path ─────────────────────────────────────────

/**
 * Compute the default output path for the slim benchmark file.
 * Example: /dir/benchmark_data.json + revpack-gpt-5-5 => /dir/benchmark_data.revpack-gpt-5-5.json
 */
export function resolveDefaultOutputPath(benchmarkDataPath: string, toolSlug: string): string {
  const dir = path.dirname(benchmarkDataPath);
  const base = path.basename(benchmarkDataPath, '.json');
  return path.join(dir, `${base}.${toolSlug}.json`);
}

// ─── Benchmark indexing ──────────────────────────────────

/**
 * Build a lookup map from GitHub identity key (owner/repo#number) to benchmark entry.
 * Skips top-level keys that are not parseable as GitHub PR URLs.
 */
export function indexBenchmarkByGitHubIdentity(benchmark: BenchmarkData): Map<string, IndexedBenchmarkEntry> {
  const index = new Map<string, IndexedBenchmarkEntry>();
  for (const [url, entry] of Object.entries(benchmark)) {
    try {
      const identity = parseGitHubPullUrl(url);
      index.set(identity.key, { canonicalPrUrl: url, value: entry });
    } catch {
      // Non-GitHub-PR keys are silently skipped during indexing
    }
  }
  return index;
}

// ─── Workspace discovery ─────────────────────────────────

/**
 * Discover immediate child directories of workspaceRoot that contain .revpack/bundle.json.
 * Does not recurse. Returns PreparedWorkspace objects for each qualifying child.
 */
export function discoverImmediateChildWorkspaces(workspaceRoot: string): PreparedWorkspace[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  } catch (err) {
    throw new Error(
      `Cannot read workspace root directory "${workspaceRoot}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  const workspaces: PreparedWorkspace[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childRoot = path.join(workspaceRoot, entry.name);
    const bundlePath = path.join(childRoot, '.revpack', 'bundle.json');
    if (fs.existsSync(bundlePath)) {
      workspaces.push({ root: childRoot });
    }
  }
  return workspaces;
}

// ─── Workspace classification ────────────────────────────

/**
 * Classify a workspace as an export candidate or a skippable workspace.
 * Pure function — does not read the filesystem.
 *
 * @param bundle         - the parsed bundle.json content
 * @param benchmarkIndex - index built from benchmark data
 * @param workspace      - workspace descriptor
 * @param findingsExists - whether .revpack/outputs/new-findings.json exists on disk
 */
export function classifyWorkspace(
  bundle: BundleState,
  benchmarkIndex: Map<string, IndexedBenchmarkEntry>,
  workspace: PreparedWorkspace,
  findingsExists: boolean,
): ExportCandidate | Skip {
  if (bundle.target.provider !== 'github' || bundle.target.type !== 'pull_request') {
    return { type: 'skip', workspace, reason: 'non-GitHub/non-pull_request target' };
  }

  let identity: GitHubPullIdentity;
  try {
    identity = parseGitHubPullUrl(bundle.target.webUrl);
  } catch {
    return {
      type: 'skip',
      workspace,
      reason: `unparseable bundle.target.webUrl: ${bundle.target.webUrl}`,
    };
  }

  const benchmarkEntry = benchmarkIndex.get(identity.key);
  if (!benchmarkEntry) {
    return {
      type: 'skip',
      workspace,
      reason: `no matching benchmark PR for ${identity.label}`,
    };
  }

  if (!findingsExists) {
    return {
      type: 'skip',
      workspace,
      reason: 'missing .revpack/outputs/new-findings.json',
    };
  }

  const findingsPath = path.join(workspace.root, '.revpack', 'outputs', 'new-findings.json');
  return { type: 'export', workspace, bundle, identity, benchmarkEntry, findingsPath };
}

// ─── Finding mapping ─────────────────────────────────────

/**
 * Map a finding + pre-rendered body to a benchmark review comment.
 * Throws if the finding has no newLine (cannot be expressed as an inline benchmark comment).
 */
export function mapFindingToBenchmarkReviewComment(finding: NewFinding, renderedBody: string): BenchmarkReviewComment {
  if (finding.newLine == null) {
    throw new Error(
      `Finding on ${finding.newPath ?? finding.oldPath} has no newLine and cannot be mapped to an inline benchmark comment. ` +
        `Only findings with a newLine are supported for benchmark export.`,
    );
  }
  return {
    path: finding.newPath ?? finding.oldPath,
    line: finding.newLine,
    body: renderedBody,
    created_at: '2000-01-01T00:00:00.000Z',
  };
}

// ─── Review entry ─────────────────────────────────────────

/**
 * Build the benchmark review entry for an exported PR.
 */
export function buildReviewEntry(
  identity: GitHubPullIdentity,
  canonicalPrUrl: string,
  tool: string,
  toolSlug: string,
  reviewComments: BenchmarkReviewComment[],
): BenchmarkReview {
  return {
    tool,
    repo_name: `${identity.owner}__${identity.repo}__${toolSlug}__PR${identity.number}__local`,
    pr_url: canonicalPrUrl,
    review_comments: reviewComments,
  };
}

// ─── Slim output ─────────────────────────────────────────

/**
 * Build the slim benchmark output, preserving the original key order from the benchmark data.
 * Only includes entries that were exported.
 */
export function buildSlimOutputPreservingBenchmarkOrder(
  originalBenchmark: BenchmarkData,
  exportedEntries: Map<string, BenchmarkPrEntry>,
): BenchmarkData {
  const result: BenchmarkData = {};
  for (const url of Object.keys(originalBenchmark)) {
    if (exportedEntries.has(url)) {
      result[url] = exportedEntries.get(url)!;
    }
  }
  return result;
}

// ─── Tool filtering ───────────────────────────────────────

/**
 * Return the subset of reviews from `entry` whose `tool` field exactly matches
 * one of the names in `toolNames`. Case-sensitive.
 * Returns an empty array when `toolNames` is empty.
 */
export function filterReviewsByTools(entry: BenchmarkPrEntry, toolNames: string[]): BenchmarkReview[] {
  if (toolNames.length === 0) return [];
  const nameSet = new Set(toolNames);
  return entry.reviews
    .filter((r) => nameSet.has(r.tool))
    .map((r) => ({
      ...r,
      review_comments: r.review_comments.filter((c) => c.path !== null),
    }));
}
