import type { ReviewComment, ReviewThread } from '../core/types.js';

function compareText(a: string | undefined, b: string | undefined): number {
  return (a ?? '').localeCompare(b ?? '');
}

/**
 * Return comments in provider-independent chronological order.
 */
export function canonicalThreadComments(thread: Pick<ReviewThread, 'comments'>): ReviewComment[] {
  return [...thread.comments].sort(
    (a, b) => compareText(a.createdAt, b.createdAt) || compareText(a.updatedAt, b.updatedAt) || compareText(a.id, b.id),
  );
}

export function nonSystemThreadComments(thread: Pick<ReviewThread, 'comments'>): ReviewComment[] {
  return canonicalThreadComments(thread).filter((comment) => !comment.system);
}

export function firstNonSystemComment(thread: Pick<ReviewThread, 'comments'>): ReviewComment | undefined {
  return nonSystemThreadComments(thread)[0];
}

export function latestNonSystemComment(thread: Pick<ReviewThread, 'comments'>): ReviewComment | undefined {
  return nonSystemThreadComments(thread).at(-1);
}

export function isSystemOnlyThread(thread: Pick<ReviewThread, 'comments'>): boolean {
  return thread.comments.every((comment) => comment.system);
}

export function threadContainsCommentId(thread: Pick<ReviewThread, 'comments'>, commentId: string): boolean {
  return thread.comments.some((comment) => comment.id === commentId);
}

export function filterReviewThreads(rawThreads: ReviewThread[], managedReviewNoteId?: string | null): ReviewThread[] {
  return rawThreads.filter(
    (thread) =>
      !isSystemOnlyThread(thread) && !(managedReviewNoteId && threadContainsCommentId(thread, managedReviewNoteId)),
  );
}

export function activeReviewThreads(threads: ReviewThread[]): ReviewThread[] {
  return threads.filter((thread) => !thread.resolved);
}
