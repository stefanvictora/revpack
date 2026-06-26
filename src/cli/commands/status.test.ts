import { describe, expect, it } from 'vitest';
import type { BundleTarget, ReviewTarget } from '../../core/types.js';
import type { GitHelper } from '../../workspace/git-helper.js';
import {
  buildBundleStatusDisplayTarget,
  buildPendingOlderBundleLines,
  buildStatusNextLines,
  compareCheckoutToTargetHead,
} from './status.js';

describe('buildBundleStatusDisplayTarget', () => {
  const bundleTarget: BundleTarget = {
    provider: 'github',
    repository: 'owner/repo',
    type: 'pull_request',
    id: '42',
    title: 'Prepared title',
    descriptionPath: '.revpack/description.md',
    author: 'octocat',
    state: 'opened',
    sourceBranch: 'feature',
    targetBranch: 'main',
    webUrl: 'https://example.com/pull/42',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    labels: [],
    diffRefs: {
      baseSha: 'base',
      headSha: 'prepared-head',
      startSha: 'start',
    },
  };

  it('uses latest provider metadata for bundle status display when available', () => {
    const latestTarget: ReviewTarget = {
      provider: 'github',
      repository: 'owner/repo',
      targetType: 'pull_request',
      targetId: '42',
      title: 'Merged title',
      description: '',
      author: 'octocat',
      state: 'merged',
      sourceBranch: 'feature',
      targetBranch: 'main',
      webUrl: 'https://example.com/pull/42',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-03T00:00:00.000Z',
      labels: [],
      diffRefs: {
        baseSha: 'base',
        headSha: 'latest-head',
        startSha: 'start',
      },
    };

    expect(buildBundleStatusDisplayTarget(bundleTarget, latestTarget)).toMatchObject({
      title: 'Merged title',
      state: 'merged',
      updatedAt: '2026-01-03T00:00:00.000Z',
    });
  });

  it('falls back to the prepared bundle target when latest provider metadata is unavailable', () => {
    expect(buildBundleStatusDisplayTarget(bundleTarget, null)).toMatchObject({
      title: 'Prepared title',
      state: 'opened',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('buildStatusNextLines', () => {
  // Checkpoint guidance is intentionally omitted when exactly one content output is ready.
  it('shows only the primary publish path when one visible output is ready', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: true,
        reviewReady: false,
        checkpointDue: true,
      }),
    ).toEqual(['Next:', '  Review .revpack/outputs/', '  revpack publish all']);
  });

  it('shows selected publish commands when at least two visible outputs are ready', () => {
    expect(
      buildStatusNextLines({
        repliesReady: true,
        findingsReady: true,
        summaryReady: true,
        reviewReady: false,
        checkpointDue: true,
      }),
    ).toEqual([
      'Next:',
      '  Review .revpack/outputs/',
      '  revpack publish all',
      '',
      'Or publish selected:',
      '  revpack publish replies',
      '  revpack publish findings',
      '  revpack publish summary',
      '',
      'After publishing selected outputs, record the review state:',
      '  revpack publish checkpoint',
    ]);
  });

  it('shows selected publish commands without checkpoint guidance when checkpoint is not due', () => {
    const lines = buildStatusNextLines({
      repliesReady: true,
      findingsReady: true,
      summaryReady: true,
      reviewReady: false,
      checkpointDue: false,
    });

    expect(lines).toEqual([
      'Next:',
      '  Review .revpack/outputs/',
      '  revpack publish all',
      '',
      'Or publish selected:',
      '  revpack publish replies',
      '  revpack publish findings',
      '  revpack publish summary',
    ]);
    expect(lines).not.toContain('After publishing selected outputs, record the review state:');
    expect(lines).not.toContain('  revpack publish checkpoint');
  });

  it('lists review note publishing as a selected content command and checkpoint separately', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: true,
        summaryReady: false,
        reviewReady: true,
        checkpointDue: true,
      }),
    ).toEqual([
      'Next:',
      '  Review .revpack/outputs/',
      '  revpack publish all',
      '',
      'Or publish selected:',
      '  revpack publish findings',
      '  revpack publish review',
      '',
      'After publishing selected outputs, record the review state:',
      '  revpack publish checkpoint',
    ]);
  });

  it('shows checkpoint directly when no visible output is ready but checkpoint is due', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: false,
        reviewReady: false,
        checkpointDue: true,
      }),
    ).toEqual(['Next:', '  revpack publish checkpoint']);
  });

  it('tells the user to push and prepare when the local checkout is ahead of the latest head', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: false,
        reviewReady: false,
        checkpointDue: true,
        checkoutRelation: 'ahead',
      }),
    ).toEqual(['Next:', '  Push local commits, then run:', '  revpack prepare']);
  });

  it('keeps checkpoint guidance when the local checkout matches the latest head', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: false,
        reviewReady: false,
        checkpointDue: true,
        checkoutRelation: 'current',
      }),
    ).toEqual(['Next:', '  revpack publish checkpoint']);
  });

  it('shows no pending publish action when nothing is ready or due', () => {
    expect(
      buildStatusNextLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: false,
        reviewReady: false,
        checkpointDue: false,
      }),
    ).toEqual(['Next:', '  No pending publish action.']);
  });
});

describe('buildPendingOlderBundleLines', () => {
  it('lists selected publish commands for pending output from a stale bundle', () => {
    expect(
      buildPendingOlderBundleLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: true,
        reviewReady: false,
      }),
    ).toEqual([
      'Still pending output from previous bundle:',
      '  Review .revpack/outputs/',
      '  revpack publish summary',
    ]);
  });

  it('lists multiple selected publish commands for pending output from a stale bundle', () => {
    expect(
      buildPendingOlderBundleLines({
        repliesReady: true,
        findingsReady: true,
        summaryReady: false,
        reviewReady: false,
      }),
    ).toEqual([
      'Still pending output from previous bundle:',
      '  Review .revpack/outputs/',
      '  revpack publish replies',
      '  revpack publish findings',
    ]);
  });

  it('omits the older bundle block when no content output is pending', () => {
    expect(
      buildPendingOlderBundleLines({
        repliesReady: false,
        findingsReady: false,
        summaryReady: false,
        reviewReady: false,
      }),
    ).toEqual([]);
  });
});

describe('compareCheckoutToTargetHead', () => {
  function gitDouble(options: {
    hasCommit: (sha: string) => boolean | Promise<boolean>;
    isAncestor?: (ancestorSha: string, descendantRef?: string) => boolean | Promise<boolean>;
  }) {
    return {
      hasCommit: options.hasCommit,
      isAncestor: options.isAncestor ?? (() => false),
    } as unknown as GitHelper;
  }

  it('reports unknown when the comparison target commit is not available locally', async () => {
    const git = gitDouble({
      hasCommit: (sha) => sha === 'current-head',
      isAncestor: () => {
        throw new Error('ancestry should not be checked for missing commits');
      },
    });

    await expect(compareCheckoutToTargetHead(git, 'missing-target-head', 'current-head')).resolves.toBe('unknown');
  });

  it('reports unknown when the current commit cannot be inspected locally', async () => {
    const git = gitDouble({
      hasCommit: (sha) => sha === 'target-head',
      isAncestor: () => {
        throw new Error('ancestry should not be checked for missing commits');
      },
    });

    await expect(compareCheckoutToTargetHead(git, 'target-head', 'missing-current-head')).resolves.toBe('unknown');
  });

  it('reports diverged only after both commits are available for ancestry checks', async () => {
    const git = gitDouble({
      hasCommit: () => true,
      isAncestor: () => false,
    });

    await expect(compareCheckoutToTargetHead(git, 'target-head', 'current-head')).resolves.toBe('diverged');
  });
});
