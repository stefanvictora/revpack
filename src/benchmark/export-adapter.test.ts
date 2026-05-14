import { describe, it, expect, assert } from 'vitest';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type { BundleState } from '../core/types.js';
import {
  slugifyToolName,
  parseGitHubPullUrl,
  resolveDefaultOutputPath,
  indexBenchmarkByGitHubIdentity,
  discoverImmediateChildWorkspaces,
  classifyWorkspace,
  mapFindingToBenchmarkReviewComment,
  buildReviewEntry,
  buildSlimOutputPreservingBenchmarkOrder,
  filterReviewsByTools,
  type BenchmarkData,
  type BenchmarkPrEntry,
  type BenchmarkReview,
  type PreparedWorkspace,
  type BenchmarkReviewComment,
} from './export-adapter.js';
import { renderPublishFindingBody } from '../workspace/finding-formatter.js';

// ─── Helpers ─────────────────────────────────────────────

function makeBundle(provider: string, type: string, webUrl: string): BundleState {
  return {
    target: { provider, type, webUrl },
  } as unknown as BundleState;
}

function makeWorkspace(root = '/workspace/project'): PreparedWorkspace {
  return { root };
}

function makeBenchmarkEntry(overrides: Partial<BenchmarkPrEntry> = {}): BenchmarkPrEntry {
  return {
    pr_title: 'Test PR',
    original_url: null,
    source_repo: 'test',
    golden_comments: [],
    golden_source_file: 'test.json',
    az_comment: null,
    reviews: [],
    ...overrides,
  };
}

// ─── slugifyToolName ──────────────────────────────────────

describe('slugifyToolName', () => {
  it('lowercases and replaces dots with hyphens', () => {
    expect(slugifyToolName('revpack-gpt-5.5')).toBe('revpack-gpt-5-5');
  });

  it('handles uppercase and slashes', () => {
    expect(slugifyToolName('revpack / GPT-5.5')).toBe('revpack-gpt-5-5');
  });

  it('handles underscores', () => {
    expect(slugifyToolName('revpack_strict')).toBe('revpack-strict');
  });

  it('returns the slug unchanged for clean names', () => {
    expect(slugifyToolName('revpack')).toBe('revpack');
  });

  it('trims leading and trailing hyphens', () => {
    expect(slugifyToolName('  /revpack/  ')).toBe('revpack');
  });
});

// ─── parseGitHubPullUrl ───────────────────────────────────

describe('parseGitHubPullUrl', () => {
  it('parses a canonical benchmark PR URL', () => {
    const result = parseGitHubPullUrl('https://github.com/keycloak/keycloak/pull/37429');
    expect(result.owner).toBe('keycloak');
    expect(result.repo).toBe('keycloak');
    expect(result.number).toBe(37429);
    expect(result.key).toBe('keycloak/keycloak#37429');
    expect(result.label).toBe('keycloak/keycloak#37429');
  });

  it('parses a bundle webUrl', () => {
    const result = parseGitHubPullUrl('https://github.com/calcom/cal.com/pull/10600');
    expect(result.owner).toBe('calcom');
    expect(result.repo).toBe('cal.com');
    expect(result.number).toBe(10600);
    expect(result.key).toBe('calcom/cal.com#10600');
  });

  it('tolerates trailing slashes', () => {
    const result = parseGitHubPullUrl('https://github.com/owner/repo/pull/42/');
    expect(result.number).toBe(42);
    expect(result.key).toBe('owner/repo#42');
  });

  it('throws for non-GitHub URLs', () => {
    expect(() => parseGitHubPullUrl('https://gitlab.com/owner/repo/-/merge_requests/1')).toThrow(
      'Not a valid GitHub pull request URL',
    );
  });

  it('throws for a GitHub URL that is not a pull request', () => {
    expect(() => parseGitHubPullUrl('https://github.com/owner/repo/issues/1')).toThrow(
      'Not a valid GitHub pull request URL',
    );
  });

  it('throws for completely invalid input', () => {
    expect(() => parseGitHubPullUrl('not-a-url')).toThrow();
  });
});

// ─── resolveDefaultOutputPath ─────────────────────────────

describe('resolveDefaultOutputPath', () => {
  it('inserts tool slug before .json extension', () => {
    const result = resolveDefaultOutputPath('/results/benchmark_data.json', 'revpack');
    expect(result).toBe(path.join('/results', 'benchmark_data.revpack.json'));
  });

  it('handles sanitized tool slug with hyphens', () => {
    const result = resolveDefaultOutputPath('/results/benchmark_data.json', 'revpack-gpt-5-5');
    expect(result).toBe(path.join('/results', 'benchmark_data.revpack-gpt-5-5.json'));
  });
});

// ─── indexBenchmarkByGitHubIdentity ──────────────────────

describe('indexBenchmarkByGitHubIdentity', () => {
  const benchmark: BenchmarkData = {
    'https://github.com/keycloak/keycloak/pull/37429': makeBenchmarkEntry({ source_repo: 'keycloak' }),
    'https://github.com/calcom/cal.com/pull/10600': makeBenchmarkEntry({ source_repo: 'calcom' }),
  };

  it('indexes by owner/repo#number key', () => {
    const index = indexBenchmarkByGitHubIdentity(benchmark);
    expect(index.has('keycloak/keycloak#37429')).toBe(true);
    expect(index.has('calcom/cal.com#10600')).toBe(true);
  });

  it('preserves the canonical PR URL', () => {
    const index = indexBenchmarkByGitHubIdentity(benchmark);
    expect(index.get('keycloak/keycloak#37429')?.canonicalPrUrl).toBe(
      'https://github.com/keycloak/keycloak/pull/37429',
    );
  });

  it('preserves the PR entry value', () => {
    const index = indexBenchmarkByGitHubIdentity(benchmark);
    expect(index.get('calcom/cal.com#10600')?.value.source_repo).toBe('calcom');
  });

  it('silently skips non-GitHub-PR top-level keys', () => {
    const mixed: BenchmarkData = {
      'https://github.com/owner/repo/pull/1': makeBenchmarkEntry(),
      'some-random-key': makeBenchmarkEntry(),
    };
    const index = indexBenchmarkByGitHubIdentity(mixed);
    expect(index.size).toBe(1);
  });
});

// ─── discoverImmediateChildWorkspaces ─────────────────────

describe('discoverImmediateChildWorkspaces', () => {
  it('returns only immediate children with .revpack/bundle.json', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revpack-test-'));
    try {
      // prepared workspace
      const prepared = path.join(tmp, 'prepared-ws');
      fs.mkdirSync(path.join(prepared, '.revpack'), { recursive: true });
      fs.writeFileSync(path.join(prepared, '.revpack', 'bundle.json'), '{}');

      // unprepared workspace (no bundle.json)
      fs.mkdirSync(path.join(tmp, 'unprepared-ws'));

      // a file (not a directory)
      fs.writeFileSync(path.join(tmp, 'some-file.txt'), '');

      // nested — should not be discovered
      const nested = path.join(tmp, 'prepared-ws', 'nested');
      fs.mkdirSync(path.join(nested, '.revpack'), { recursive: true });
      fs.writeFileSync(path.join(nested, '.revpack', 'bundle.json'), '{}');

      const result = discoverImmediateChildWorkspaces(tmp);
      expect(result).toHaveLength(1);
      expect(result[0].root).toBe(prepared);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('returns empty array when no prepared workspaces exist', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'revpack-test-'));
    try {
      fs.mkdirSync(path.join(tmp, 'plain-dir'));
      const result = discoverImmediateChildWorkspaces(tmp);
      expect(result).toHaveLength(0);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('throws when workspace root does not exist', () => {
    expect(() => discoverImmediateChildWorkspaces('/nonexistent/path/that/does/not/exist')).toThrow();
  });
});

// ─── classifyWorkspace ────────────────────────────────────

describe('classifyWorkspace', () => {
  const benchmarkEntry = makeBenchmarkEntry();
  const benchmarkIndex = new Map([
    ['owner/repo#42', { canonicalPrUrl: 'https://github.com/owner/repo/pull/42', value: benchmarkEntry }],
  ]);
  const workspace = makeWorkspace();

  it('classifies a matching GitHub PR workspace as export', () => {
    const bundle = makeBundle('github', 'pull_request', 'https://github.com/owner/repo/pull/42');
    const result = classifyWorkspace(bundle, benchmarkIndex, workspace, true);
    assert(result.type === 'export');
    expect(result.identity.key).toBe('owner/repo#42');
    expect(result.benchmarkEntry.canonicalPrUrl).toBe('https://github.com/owner/repo/pull/42');
  });

  it('skips non-GitHub targets', () => {
    const bundle = makeBundle('gitlab', 'merge_request', 'https://gitlab.com/owner/repo/-/merge_requests/1');
    const result = classifyWorkspace(bundle, benchmarkIndex, workspace, true);
    assert(result.type === 'skip');
    expect(result.reason).toContain('non-GitHub/non-pull_request target');
  });

  it('skips GitHub issues (non-PR type)', () => {
    const bundle = makeBundle('github', 'merge_request', 'https://github.com/owner/repo/pull/42');
    const result = classifyWorkspace(bundle, benchmarkIndex, workspace, true);
    expect(result.type).toBe('skip');
  });

  it('skips when no matching benchmark PR', () => {
    const bundle = makeBundle('github', 'pull_request', 'https://github.com/owner/repo/pull/999');
    const result = classifyWorkspace(bundle, benchmarkIndex, workspace, true);
    assert(result.type === 'skip');
    expect(result.reason).toContain('owner/repo#999');
  });

  it('skips when findings file is missing', () => {
    const bundle = makeBundle('github', 'pull_request', 'https://github.com/owner/repo/pull/42');
    const result = classifyWorkspace(bundle, benchmarkIndex, workspace, false);
    assert(result.type === 'skip');
    expect(result.reason).toContain('missing .revpack/outputs/new-findings.json');
  });
});

// ─── mapFindingToBenchmarkReviewComment ───────────────────

describe('mapFindingToBenchmarkReviewComment', () => {
  it('maps a finding with newLine to a benchmark comment', () => {
    const finding = {
      oldPath: 'src/foo.ts',
      newPath: 'src/foo.ts',
      newLine: 10,
      body: 'This is a problem',
      severity: 'high' as const,
      category: 'correctness' as const,
    };
    const renderedBody = renderPublishFindingBody(finding);
    const comment = mapFindingToBenchmarkReviewComment(finding, renderedBody);

    expect(comment.path).toBe('src/foo.ts');
    expect(comment.line).toBe(10);
    expect(comment.body).toBe(renderedBody);
    expect(comment.created_at).toBe('2000-01-01T00:00:00.000Z');
  });

  it('uses newPath when both paths are set', () => {
    const finding = {
      oldPath: 'src/old.ts',
      newPath: 'src/new.ts',
      newLine: 5,
      body: 'Finding body',
      severity: 'low' as const,
      category: 'style' as const,
    };
    const comment = mapFindingToBenchmarkReviewComment(finding, 'rendered');
    expect(comment.path).toBe('src/new.ts');
  });

  it('throws when newLine is missing', () => {
    const finding = {
      oldPath: 'src/foo.ts',
      newPath: 'src/foo.ts',
      oldLine: 10,
      body: 'Removed line finding',
      severity: 'medium' as const,
      category: 'correctness' as const,
    };
    expect(() => mapFindingToBenchmarkReviewComment(finding, 'rendered')).toThrow('no newLine');
  });

  it('uses deterministic created_at', () => {
    const finding = {
      oldPath: 'a.ts',
      newPath: 'a.ts',
      newLine: 1,
      body: 'x',
      severity: 'nit' as const,
      category: 'style' as const,
    };
    const c1 = mapFindingToBenchmarkReviewComment(finding, 'body1');
    const c2 = mapFindingToBenchmarkReviewComment(finding, 'body2');
    expect(c1.created_at).toBe('2000-01-01T00:00:00.000Z');
    expect(c2.created_at).toBe('2000-01-01T00:00:00.000Z');
  });

  it('normalizes CRLF line endings in the body', () => {
    const finding = {
      oldPath: 'a.ts',
      newPath: 'a.ts',
      newLine: 1,
      body: 'first\r\nsecond',
      severity: 'nit' as const,
      category: 'style' as const,
    };
    const rendered = renderPublishFindingBody(finding).replaceAll('\r\n', '\n');
    expect(rendered).not.toContain('\r\n');
    const comment = mapFindingToBenchmarkReviewComment(finding, rendered);
    expect(comment.body).not.toContain('\r\n');
  });
});

// ─── buildReviewEntry ─────────────────────────────────────

describe('buildReviewEntry', () => {
  const identity = parseGitHubPullUrl('https://github.com/calcom/cal.com/pull/10600');

  it('sets the tool name as provided', () => {
    const review = buildReviewEntry(
      identity,
      'https://github.com/calcom/cal.com/pull/10600',
      'revpack-gpt-5.5',
      'revpack-gpt-5-5',
      [],
    );
    expect(review.tool).toBe('revpack-gpt-5.5');
  });

  it('builds repo_name with sanitized tool slug', () => {
    const review = buildReviewEntry(
      identity,
      'https://github.com/calcom/cal.com/pull/10600',
      'revpack-gpt-5.5',
      'revpack-gpt-5-5',
      [],
    );
    expect(review.repo_name).toBe('calcom__cal.com__revpack-gpt-5-5__PR10600__local');
  });

  it('preserves original owner and repo in repo_name (no sanitization)', () => {
    const id = parseGitHubPullUrl('https://github.com/keycloak/keycloak/pull/37429');
    const review = buildReviewEntry(id, 'https://github.com/keycloak/keycloak/pull/37429', 'revpack', 'revpack', []);
    expect(review.repo_name).toBe('keycloak__keycloak__revpack__PR37429__local');
  });

  it('sets pr_url to the canonical benchmark URL', () => {
    const canonicalUrl = 'https://github.com/calcom/cal.com/pull/10600';
    const review = buildReviewEntry(identity, canonicalUrl, 'revpack', 'revpack', []);
    expect(review.pr_url).toBe(canonicalUrl);
  });

  it('maps empty findings to empty review_comments', () => {
    const review = buildReviewEntry(identity, 'https://github.com/calcom/cal.com/pull/10600', 'revpack', 'revpack', []);
    expect(review.review_comments).toEqual([]);
  });
});

// ─── buildSlimOutputPreservingBenchmarkOrder ──────────────

describe('buildSlimOutputPreservingBenchmarkOrder', () => {
  const entry1 = makeBenchmarkEntry({ source_repo: 'repo1', reviews: [] });
  const entry2 = makeBenchmarkEntry({ source_repo: 'repo2', reviews: [] });
  const entry3 = makeBenchmarkEntry({ source_repo: 'repo3', reviews: [] });

  const originalBenchmark: BenchmarkData = {
    'https://github.com/owner/repo/pull/1': entry1,
    'https://github.com/owner/repo/pull/2': entry2,
    'https://github.com/owner/repo/pull/3': entry3,
  };

  it('includes only exported entries', () => {
    const exportedEntry: BenchmarkPrEntry = {
      ...entry1,
      reviews: [{ tool: 'revpack', repo_name: 'x', pr_url: 'y', review_comments: [] }],
    };
    const exportedEntries = new Map([['https://github.com/owner/repo/pull/1', exportedEntry]]);
    const result = buildSlimOutputPreservingBenchmarkOrder(originalBenchmark, exportedEntries);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result['https://github.com/owner/repo/pull/1']).toBe(exportedEntry);
  });

  it('preserves the original benchmark key order', () => {
    const exported2: BenchmarkPrEntry = { ...entry2, reviews: [] };
    const exported3: BenchmarkPrEntry = { ...entry3, reviews: [] };
    const exportedEntries = new Map([
      ['https://github.com/owner/repo/pull/3', exported3],
      ['https://github.com/owner/repo/pull/2', exported2],
    ]);
    const result = buildSlimOutputPreservingBenchmarkOrder(originalBenchmark, exportedEntries);
    const keys = Object.keys(result);
    expect(keys[0]).toBe('https://github.com/owner/repo/pull/2');
    expect(keys[1]).toBe('https://github.com/owner/repo/pull/3');
  });

  it('preserves PR-level metadata in exported entries', () => {
    const exportedEntry: BenchmarkPrEntry = {
      ...entry1,
      reviews: [{ tool: 'revpack', repo_name: 'r', pr_url: 'u', review_comments: [] }],
    };
    const exportedEntries = new Map([['https://github.com/owner/repo/pull/1', exportedEntry]]);
    const result = buildSlimOutputPreservingBenchmarkOrder(originalBenchmark, exportedEntries);
    expect(result['https://github.com/owner/repo/pull/1'].source_repo).toBe('repo1');
  });

  it('reviews contains exactly one review entry for the selected tool', () => {
    const review: BenchmarkReview = {
      tool: 'revpack',
      repo_name: 'owner__repo__revpack__PR1__local',
      pr_url: 'https://github.com/owner/repo/pull/1',
      review_comments: [],
    };
    const exportedEntry: BenchmarkPrEntry = { ...entry1, reviews: [review] };
    const exportedEntries = new Map([['https://github.com/owner/repo/pull/1', exportedEntry]]);
    const result = buildSlimOutputPreservingBenchmarkOrder(originalBenchmark, exportedEntries);
    expect(result['https://github.com/owner/repo/pull/1'].reviews).toHaveLength(1);
    expect(result['https://github.com/owner/repo/pull/1'].reviews[0].tool).toBe('revpack');
  });
});

// ─── renderPublishFindingBody (formatter integration) ─────

describe('renderPublishFindingBody', () => {
  it('prepends severity/category header to body', () => {
    const finding = {
      severity: 'high' as const,
      category: 'security' as const,
      body: 'SQL injection risk here.',
    };
    const rendered = renderPublishFindingBody(finding);
    expect(rendered).toContain('🔴');
    expect(rendered).toContain('High');
    expect(rendered).toContain('security');
    expect(rendered).toContain('SQL injection risk here.');
  });

  it('uses consistent format: _icon Severity_ | _category_', () => {
    const rendered = renderPublishFindingBody({ severity: 'medium', category: 'correctness', body: 'body' });
    expect(rendered.startsWith('_🟡 Medium_ | _correctness_')).toBe(true);
  });
});
// ─── filterReviewsByTools ─────────────────────────────────

describe('filterReviewsByTools', () => {
  const review = (tool: string, comments: BenchmarkReviewComment[] = []): BenchmarkReview => ({
    tool,
    repo_name: `owner__repo__${tool}__PR1__local`,
    pr_url: 'https://github.com/owner/repo/pull/1',
    review_comments: comments,
  });

  const positional: BenchmarkReviewComment = { path: 'src/foo.ts', line: 10, body: 'positional', created_at: '' };
  const nonPositional: BenchmarkReviewComment = { path: null, line: 0, body: 'summary', created_at: '' };

  const entry: BenchmarkPrEntry = {
    reviews: [review('gpt-4o'), review('claude-3-5-sonnet'), review('revpack')],
  };

  it('returns only reviews matching the specified tool names', () => {
    const result = filterReviewsByTools(entry, ['gpt-4o']);
    expect(result).toHaveLength(1);
    expect(result[0].tool).toBe('gpt-4o');
  });

  it('returns multiple matching reviews', () => {
    const result = filterReviewsByTools(entry, ['gpt-4o', 'claude-3-5-sonnet']);
    expect(result.map((r) => r.tool)).toEqual(['gpt-4o', 'claude-3-5-sonnet']);
  });

  it('returns empty array when no names match', () => {
    expect(filterReviewsByTools(entry, ['unknown-tool'])).toEqual([]);
  });

  it('returns empty array when includeTools is empty', () => {
    expect(filterReviewsByTools(entry, [])).toEqual([]);
  });

  it('is case-sensitive', () => {
    expect(filterReviewsByTools(entry, ['GPT-4O'])).toEqual([]);
    expect(filterReviewsByTools(entry, ['gpt-4o'])).toHaveLength(1);
  });

  it('strips non-positional comments (path: null) from included reviews', () => {
    const entryWithMixed: BenchmarkPrEntry = {
      reviews: [review('gpt-4o', [positional, nonPositional, positional])],
    };
    const result = filterReviewsByTools(entryWithMixed, ['gpt-4o']);
    expect(result).toHaveLength(1);
    expect(result[0].review_comments).toHaveLength(2);
    expect(result[0].review_comments.every((c) => c.path !== null)).toBe(true);
  });
});
