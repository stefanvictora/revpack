import { describe, expect, it } from 'vitest';
import type { ReviewThread } from '../core/types.js';
import {
  computeAggregateThreadsDigest,
  computeContentHash,
  computeThreadDigest,
  computeThreadDigestMap,
  DIGEST_VERSION,
  sha256,
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

  it('computes prefixed SHA-256 hashes', () => {
    expect(sha256('hello')).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('is stable when providers return comments in a different order', () => {
    const reordered = {
      ...baseThread,
      comments: [...baseThread.comments].reverse(),
    };

    expect(computeThreadDigest(reordered)).toBe(computeThreadDigest(baseThread));
  });

  it('preserves the canonical digest for a representative thread', () => {
    expect(computeThreadDigest(baseThread)).toBe(
      'sha256:177136cafc4694117053ae6d6a41ee8e15a2cc66e4c4091eb1b5ff4b6cb52632',
    );
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

  it.each([
    ['thread id', { threadId: 'thread-2' }],
    ['resolvable flag', { resolvable: false }],
    ['missing position', { position: undefined }],
  ] satisfies Array<[string, Partial<ReviewThread>]>)('changes when %s changes', (_label, overrides) => {
    expect(computeThreadDigest({ ...baseThread, ...overrides })).not.toBe(computeThreadDigest(baseThread));
  });

  it.each([
    ['comment id', { id: 'note-3' }],
    ['comment body', { body: 'Different body' }],
    ['comment author', { author: 'bob' }],
    ['comment origin', { origin: 'bot' as const }],
    ['comment system flag', { system: true }],
    ['comment created timestamp', { createdAt: '2026-01-01T00:30:00Z' }],
    ['comment updated timestamp', { updatedAt: '2026-01-01T00:30:00Z' }],
  ])('changes when %s changes', (_label, commentOverrides) => {
    const changed = {
      ...baseThread,
      comments: [{ ...baseThread.comments[0], ...commentOverrides }],
    };

    expect(computeThreadDigest(changed)).not.toBe(computeThreadDigest(baseThread));
  });

  it('normalizes missing optional fields to null in the digest', () => {
    const omitted = {
      ...baseThread,
      resolvedBy: undefined,
      resolvedAt: undefined,
      position: {
        filePath: undefined,
        oldPath: undefined,
        newPath: undefined,
        oldLine: undefined,
        newLine: undefined,
        baseSha: undefined,
        headSha: undefined,
        startSha: undefined,
      },
    };
    const explicitNulls = {
      ...omitted,
      resolvedBy: null,
      resolvedAt: null,
      position: {
        filePath: null,
        oldPath: null,
        newPath: null,
        oldLine: null,
        newLine: null,
        baseSha: null,
        headSha: null,
        startSha: null,
      },
    };

    expect(computeThreadDigest(omitted as unknown as ReviewThread)).toBe(
      computeThreadDigest(explicitNulls as unknown as ReviewThread),
    );
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

  it('changes aggregate digest content when thread digests change', () => {
    const thread2 = { ...baseThread, threadId: 'thread-2' };
    const changedThread2 = { ...thread2, resolved: true };

    expect(computeAggregateThreadsDigest([baseThread, changedThread2])).not.toBe(
      computeAggregateThreadsDigest([baseThread, thread2]),
    );
  });

  it('preserves the canonical aggregate digest for a representative thread list', () => {
    expect(computeAggregateThreadsDigest([baseThread])).toBe(
      'sha256:04b4cd58867869df988d2bc137ae3cea6f014077bccfb9439c1b1712f3ec399e',
    );
  });
});
