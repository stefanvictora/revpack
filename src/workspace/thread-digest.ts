import { createHash } from 'node:crypto';
import type { ReviewThread } from '../core/types.js';
import { canonicalThreadComments } from './thread-utils.js';

const DIGEST_VERSION = 2;

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
  return text.replace(/\r\n?/g, '\n');
}

function nullable<T>(value: T | undefined): T | null {
  return value ?? null;
}

/**
 * Build a normalized projection of a thread for digest computation.
 */
function threadProjection(thread: ReviewThread): object {
  return {
    digestVersion: DIGEST_VERSION,
    providerThreadId: thread.threadId,
    resolved: thread.resolved,
    resolvable: thread.resolvable,
    resolvedBy: nullable(thread.resolvedBy),
    resolvedAt: nullable(thread.resolvedAt),
    position: thread.position
      ? {
          filePath: nullable(thread.position.filePath),
          oldPath: nullable(thread.position.oldPath),
          newPath: nullable(thread.position.newPath),
          oldLine: nullable(thread.position.oldLine),
          newLine: nullable(thread.position.newLine),
          baseSha: nullable(thread.position.baseSha),
          headSha: nullable(thread.position.headSha),
          startSha: nullable(thread.position.startSha),
        }
      : null,
    comments: canonicalThreadComments(thread).map((c) => ({
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
 * Compute a map of thread ID → digest for all threads.
 */
export function computeThreadDigestMap(threads: ReviewThread[]): Record<string, string> {
  return Object.fromEntries(threads.map((t) => [t.threadId, computeThreadDigest(t)]));
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
