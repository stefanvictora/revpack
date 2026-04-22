import { describe, it, expect } from 'vitest';
import { SummaryGenerator } from '../orchestration/summary-generator.js';
import type { ReviewTarget, ReviewDiff, ReviewThread } from '../core/types.js';

const makeTarget = (overrides?: Partial<ReviewTarget>): ReviewTarget => ({
  provider: 'gitlab',
  repository: 'group/project',
  targetType: 'merge_request',
  targetId: '42',
  title: 'Add user authentication',
  description: 'Implements OAuth2 login flow',
  author: 'alice',
  state: 'opened',
  sourceBranch: 'feature/auth',
  targetBranch: 'main',
  webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
  createdAt: '2026-01-15T10:00:00Z',
  updatedAt: '2026-01-16T14:00:00Z',
  labels: ['feature', 'security'],
  diffRefs: { baseSha: 'abc123', headSha: 'def456', startSha: 'abc123' },
  ...overrides,
});

const makeDiff = (overrides?: Partial<ReviewDiff>): ReviewDiff => ({
  oldPath: 'src/auth.ts',
  newPath: 'src/auth.ts',
  diff: `@@ -1,5 +1,10 @@\n import { User } from './user';\n+import { OAuth2Client } from './oauth';\n`,
  newFile: false,
  renamedFile: false,
  deletedFile: false,
  ...overrides,
});

const makeThread = (overrides?: Partial<ReviewThread>): ReviewThread => ({
  provider: 'gitlab',
  targetRef: {
    provider: 'gitlab',
    repository: 'group/project',
    targetType: 'merge_request',
    targetId: '42',
  },
  threadId: 't-1',
  resolved: false,
  resolvable: true,
  comments: [
    { id: 'c-1', body: 'Check null case', author: 'bob', createdAt: '', updatedAt: '', origin: 'human', system: false },
  ],
  ...overrides,
});

describe('SummaryGenerator', () => {
  const gen = new SummaryGenerator();

  it('generates a complete summary', () => {
    const target = makeTarget();
    const diffs = [
      makeDiff(),
      makeDiff({ newPath: 'src/oauth.ts', oldPath: 'src/oauth.ts', newFile: true }),
    ];
    const threads = [
      makeThread(),
      makeThread({ threadId: 't-2', resolved: true }),
    ];

    const summary = gen.generateSummary(target, diffs, threads);

    expect(summary.targetRef.targetId).toBe('42');
    expect(summary.changedFilesSummary).toHaveLength(2);
    expect(summary.unresolvedThreadCount).toBe(1);
    expect(summary.resolvedThreadCount).toBe(1);
    expect(summary.highLevelSummary).toContain('2 changed file(s)');
    expect(summary.highLevelSummary).toContain('!42');
  });

  it('generates valid markdown', () => {
    const target = makeTarget();
    const diffs = [makeDiff()];
    const threads = [makeThread()];

    const summary = gen.generateSummary(target, diffs, threads);
    const md = gen.generateMarkdown(summary);

    expect(md).toContain('<!-- review-assist:summary -->');
    expect(md).toContain('## Summary by review-assist');
    expect(md).toContain('* **Changes**');
    expect(md).toContain('`src/auth.ts`');
    expect(md).toContain('<!-- end of review-assist:summary -->');
  });

  it('categorizes file changes correctly', () => {
    const target = makeTarget();
    const diffs = [
      makeDiff({ newFile: true, newPath: 'new-file.ts', oldPath: 'new-file.ts' }),
      makeDiff({ deletedFile: true, newPath: 'old-file.ts', oldPath: 'old-file.ts' }),
      makeDiff({ renamedFile: true, oldPath: 'old-name.ts', newPath: 'new-name.ts' }),
      makeDiff(),
    ];

    const summary = gen.generateSummary(target, diffs, []);

    const changeTypes = summary.changedFilesSummary.map((f) => f.changeType);
    expect(changeTypes).toContain('added');
    expect(changeTypes).toContain('deleted');
    expect(changeTypes).toContain('renamed');
    expect(changeTypes).toContain('modified');
  });

  it('handles empty diffs and threads', () => {
    const target = makeTarget();
    const summary = gen.generateSummary(target, [], []);

    expect(summary.changedFilesSummary).toHaveLength(0);
    expect(summary.unresolvedThreadCount).toBe(0);
    expect(summary.resolvedThreadCount).toBe(0);
  });

  it('includes labels in high-level summary', () => {
    const target = makeTarget({ labels: ['urgent', 'backend'] });
    const summary = gen.generateSummary(target, [], []);

    expect(summary.highLevelSummary).toContain('urgent');
    expect(summary.highLevelSummary).toContain('backend');
  });
});
