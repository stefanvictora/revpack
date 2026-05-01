import { describe, expect, it } from 'vitest';
import type { ReviewThread } from '../core/types.js';
import {
  computeAggregateThreadsDigest,
  computeContentHash,
  computeThreadDigest,
  computeThreadDigestMap,
  DIGEST_VERSION,
} from './thread-digest.js';

const baseThread: ReviewThread = {
  provider: 'gitlab',
  targetRef: {
    provider: 'gitlab',
    repository: 'group/project',
    targetType: 'merge_request',
    targetId: '42',
  },
  threadId: 'thread-1',
  resolved: false,
  resolvable: true,
  position: {
    filePath: 'src/app.ts',
    oldPath: 'src/app.ts',
    newPath: 'src/app.ts',
    newLine: 12,
    baseSha: 'base',
    headSha: 'head',
    startSha: 'start',
  },
  comments: [
    {
      id: 'note-1',
      body: 'Please handle null here.',
      author: 'reviewer',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      origin: 'human',
      system: false,
    },
    {
      id: 'note-2',
      body: 'Pushed a fix.',
      author: 'alice',
      createdAt: '2026-01-01T01:00:00Z',
      updatedAt: '2026-01-01T01:00:00Z',
      origin: 'human',
      system: false,
    },
  ],
};

describe('thread digest', () => {
  it('uses the current digest version', () => {
    expect(DIGEST_VERSION).toBe(2);
  });

  it('is stable when providers return comments in a different order', () => {
    const reordered = {
      ...baseThread,
      comments: [...baseThread.comments].reverse(),
    };

    expect(computeThreadDigest(reordered)).toBe(computeThreadDigest(baseThread));
  });

  it('normalizes CRLF and CR line endings in comment bodies and content hashes', () => {
    const lfThread = {
      ...baseThread,
      comments: [{ ...baseThread.comments[0], body: 'line 1\nline 2' }],
    };
    const crlfThread = {
      ...baseThread,
      comments: [{ ...baseThread.comments[0], body: 'line 1\r\nline 2' }],
    };
    const crThread = {
      ...baseThread,
      comments: [{ ...baseThread.comments[0], body: 'line 1\rline 2' }],
    };

    expect(computeThreadDigest(crlfThread)).toBe(computeThreadDigest(lfThread));
    expect(computeThreadDigest(crThread)).toBe(computeThreadDigest(lfThread));
    expect(computeContentHash('a\rb')).toBe(computeContentHash('a\nb'));
  });

  it('changes when position revision metadata changes', () => {
    const moved = {
      ...baseThread,
      position: { ...baseThread.position!, headSha: 'new-head' },
    };

    expect(computeThreadDigest(moved)).not.toBe(computeThreadDigest(baseThread));
  });

  it('changes when resolution metadata changes', () => {
    const resolved = {
      ...baseThread,
      resolved: true,
      resolvedBy: 'maintainer',
      resolvedAt: '2026-01-01T02:00:00Z',
    };

    expect(computeThreadDigest(resolved)).not.toBe(computeThreadDigest(baseThread));
  });

  it('sorts aggregate digest inputs by provider thread ID', () => {
    const thread2 = { ...baseThread, threadId: 'thread-2' };

    expect(computeAggregateThreadsDigest([thread2, baseThread])).toBe(
      computeAggregateThreadsDigest([baseThread, thread2]),
    );
    expect(computeThreadDigestMap([baseThread])).toEqual({
      'thread-1': computeThreadDigest(baseThread),
    });
  });
});
