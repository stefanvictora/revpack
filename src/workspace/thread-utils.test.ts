import { describe, expect, it } from 'vitest';
import type { ReviewComment, ReviewThread } from '../core/types.js';
import {
  activeReviewThreads,
  canonicalThreadComments,
  filterReviewThreads,
  firstNonSystemComment,
  isSystemOnlyThread,
  latestNonSystemComment,
  nonSystemThreadComments,
} from './thread-utils.js';

describe('thread utilities', () => {
  it('sorts comments by created time, updated time, then id without mutating the input', () => {
    const late = makeComment('late', { createdAt: '2024-01-03T00:00:00Z' });
    const byId = makeComment('b', { createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' });
    const first = makeComment('first', { createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z' });
    const byIdFirst = makeComment('a', { createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-02T00:00:00Z' });
    const comments = [late, byId, first, byIdFirst];

    expect(canonicalThreadComments({ comments }).map((comment) => comment.id)).toEqual(['first', 'a', 'b', 'late']);
    expect(comments.map((comment) => comment.id)).toEqual(['late', 'b', 'first', 'a']);
  });

  it('sorts comments with missing timestamps as empty text', () => {
    const withoutDates = makeComment('without-dates', { createdAt: undefined, updatedAt: undefined });
    const withDate = makeComment('with-date', { createdAt: '2024-01-01T00:00:00Z' });

    expect(canonicalThreadComments({ comments: [withDate, withoutDates] }).map((comment) => comment.id)).toEqual([
      'without-dates',
      'with-date',
    ]);
  });

  it('sorts a comment with a missing right-hand timestamp before a later timestamp', () => {
    const withDate = makeComment('with-date', { createdAt: '2024-01-01T00:00:00Z' });
    const withoutDate = makeComment('without-date', { createdAt: undefined });

    expect(canonicalThreadComments({ comments: [withDate, withoutDate] }).map((comment) => comment.id)).toEqual([
      'without-date',
      'with-date',
    ]);
  });

  it('returns non-system comments in canonical order', () => {
    const system = makeComment('system', { system: true, createdAt: '2024-01-01T00:00:00Z' });
    const second = makeComment('second', { createdAt: '2024-01-03T00:00:00Z' });
    const third = makeComment('third', { createdAt: '2024-01-04T00:00:00Z' });
    const first = makeComment('first', { createdAt: '2024-01-02T00:00:00Z' });

    expect(nonSystemThreadComments({ comments: [system, second, third, first] }).map((comment) => comment.id)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(firstNonSystemComment({ comments: [system, second, third, first] })?.id).toBe('first');
    expect(latestNonSystemComment({ comments: [system, second, third, first] })?.id).toBe('third');
  });

  it('returns undefined when a thread has no non-system comments', () => {
    const comments = [makeComment('system-1', { system: true }), makeComment('system-2', { system: true })];

    expect(firstNonSystemComment({ comments })).toBeUndefined();
    expect(latestNonSystemComment({ comments })).toBeUndefined();
    expect(isSystemOnlyThread({ comments })).toBe(true);
  });

  it('does not treat mixed threads as system-only', () => {
    expect(isSystemOnlyThread({ comments: [makeComment('system', { system: true }), makeComment('human')] })).toBe(
      false,
    );
  });

  it('filters system-only threads', () => {
    const visible = makeThread('visible', { comments: [makeComment('visible-comment')] });
    const systemOnly = makeThread('system-only', { comments: [makeComment('system-comment', { system: true })] });
    const managed = makeThread('managed', { comments: [makeComment('managed-note')] });

    expect(filterReviewThreads([visible, systemOnly, managed]).map((thread) => thread.threadId)).toEqual([
      'visible',
      'managed',
    ]);
  });

  it('keeps only unresolved review threads', () => {
    const unresolved = makeThread('unresolved', { resolved: false });
    const resolved = makeThread('resolved', { resolved: true });

    expect(activeReviewThreads([unresolved, resolved])).toEqual([unresolved]);
  });
});

function makeComment(id: string, overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id,
    body: `${id} body`,
    author: 'alice',
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
    origin: 'human',
    system: false,
    ...overrides,
  };
}

function makeThread(threadId: string, overrides: Partial<ReviewThread> = {}): ReviewThread {
  return {
    provider: 'github',
    targetRef: {
      provider: 'github',
      repository: 'owner/repo',
      targetType: 'pull_request',
      targetId: '1',
    },
    threadId,
    resolved: false,
    resolvable: true,
    comments: [makeComment(`${threadId}-comment`)],
    ...overrides,
  };
}
