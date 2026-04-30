import { createHash } from 'node:crypto';
import type { ReviewThread } from '../core/types.js';

const DIGEST_VERSION = 1;

/**
 * Compute a SHA-256 hash of a string.
 */
function sha256(input: string): string {
  return `sha256:${createHash('sha256').update(input, 'utf-8').digest('hex')}`;
}

/**
 * Normalize line endings to \n.
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

/**
 * Build a normalized projection of a thread for digest computation.
 */
function threadProjection(thread: ReviewThread): object {
  return {
    providerThreadId: thread.threadId,
    resolved: thread.resolved,
    resolvable: thread.resolvable,
    position: thread.position
      ? {
          oldPath: thread.position.oldPath ?? null,
          newPath: thread.position.newPath ?? null,
          oldLine: thread.position.oldLine ?? null,
          newLine: thread.position.newLine ?? null,
        }
      : null,
    comments: thread.comments.map((c) => ({
      id: c.id,
      bodyHash: sha256(normalizeLineEndings(c.body)),
      author: c.author,
      origin: c.origin,
      system: c.system,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    })),
  };
}

/**
 * Deep sort for canonical serialization — sorts all object keys recursively.
 */
function deepSort(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(deepSort);
  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = deepSort((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute a per-thread digest.
 */
export function computeThreadDigest(thread: ReviewThread): string {
  const projection = threadProjection(thread);
  const canonical = JSON.stringify(deepSort(projection));
  return sha256(canonical);
}

/**
 * Compute an aggregate threads digest from all threads.
 * Threads are sorted by providerThreadId for stability.
 */
export function computeAggregateThreadsDigest(threads: ReviewThread[]): string {
  const items = threads
    .map((t) => ({
      providerThreadId: t.threadId,
      digest: computeThreadDigest(t),
    }))
    .sort((a, b) => a.providerThreadId.localeCompare(b.providerThreadId));

  const input = { digestVersion: DIGEST_VERSION, threads: items };
  const canonical = JSON.stringify(deepSort(input));
  return sha256(canonical);
}

/**
 * Compute a SHA-256 content hash for output file change detection.
 */
export function computeContentHash(content: string): string {
  return sha256(normalizeLineEndings(content));
}

export { DIGEST_VERSION, sha256 };
