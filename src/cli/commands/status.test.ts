import { describe, expect, it } from 'vitest';
import { buildPendingOlderBundleLines, buildStatusNextLines } from './status.js';

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
