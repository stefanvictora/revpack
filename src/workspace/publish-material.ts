import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  BundleState,
  NewFinding,
  OutputState,
  PublishSelection,
  ReplyDraft,
  ReviewThread,
} from '../core/types.js';
import { newFindingsArraySchema, repliesArraySchema } from '../core/schemas.js';
import { computeContentHash } from './thread-digest.js';
import { parsePatch } from './patch-parser.js';
import { formatValidationErrors, validateFindings } from './finding-validator.js';
import { extractDiffContext } from './diff-context.js';

export const DEFAULT_PUBLISH_PATHS = {
  findings: '.revpack/outputs/new-findings.json',
  replies: '.revpack/outputs/replies.json',
  summary: '.revpack/outputs/summary.md',
  note: '.revpack/outputs/note.md',
  patch: '.revpack/diffs/latest.patch',
} as const;

export interface IndexedDraft<T> {
  index: number;
  value: T;
  raw: unknown;
}

export interface PublishDocumentMaterial {
  path: string;
  state: OutputState;
  content: string;
}

export type CheckpointPublishState = 'none' | 'current' | 'outdated' | 'unknown';

export interface PublishMaterial {
  bundleState: BundleState;
  findingsPath: string;
  repliesPath: string;
  findings: IndexedDraft<NewFinding>[];
  findingContexts: Map<number, string>;
  replies: IndexedDraft<ReplyDraft>[];
  replyContexts: Map<number, ReviewThread>;
  summary: PublishDocumentMaterial;
  note: PublishDocumentMaterial;
  checkpointState: CheckpointPublishState;
}

export interface RemovePublishedDraftsOptions {
  deleteWhenEmpty?: boolean;
  expectedEntries?: ReadonlyArray<unknown>;
}

async function writeJsonArrayAtomically(filePath: string, entries: ReadonlyArray<unknown>): Promise<void> {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    await fs.writeFile(tempPath, JSON.stringify(entries, null, 2), { encoding: 'utf-8', flag: 'wx' });
    await fs.rename(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        await fs.rm(tempPath, { force: true });
      } catch {
        // Preserve the write/rename failure; the best-effort temporary cleanup must not hide it.
      }
    }
  }
}

export async function removePublishedDrafts<T>(
  filePath: string,
  drafts: ReadonlyArray<IndexedDraft<T>>,
  publishedIndexes: ReadonlySet<number>,
  options?: RemovePublishedDraftsOptions,
): Promise<boolean> {
  const retained = drafts.filter((draft) => !publishedIndexes.has(draft.index));
  if (retained.length === drafts.length) return false;
  if (options?.expectedEntries !== undefined) {
    const currentEntries = await readOptionalJsonArray(filePath, 'draft objects');
    if (!isDeepStrictEqual(currentEntries, options.expectedEntries)) {
      throw new Error(`${filePath} changed after publish material was loaded; the newer queue was left unchanged.`);
    }
  }
  if (retained.length === 0 && options?.deleteWhenEmpty) {
    await fs.rm(filePath, { force: true });
    return true;
  }
  await writeJsonArrayAtomically(
    filePath,
    retained.map((draft) => draft.raw),
  );
  return true;
}

export async function clearPublishedDocument(filePath: string, expectedContent?: string): Promise<void> {
  if (expectedContent !== undefined) {
    const currentContent = await readOptionalFile(filePath);
    if (currentContent !== expectedContent) {
      throw new Error(`${filePath} changed after publish material was loaded; the newer document was left unchanged.`);
    }
  }
  await fs.rm(filePath, { force: true });
}

function resolveWorkspacePath(workingDir: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.resolve(workingDir, filePath);
}

function isPathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function nearestExistingRealPath(candidate: string): Promise<{ lexical: string; real: string }> {
  let current = candidate;
  while (true) {
    try {
      return { lexical: current, real: await fs.realpath(current) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function resolveBundleOutputPath(workingDir: string, filePath: unknown, label: string): Promise<string> {
  const expectedRoot = path.resolve(workingDir, '.revpack', 'outputs');
  if (typeof filePath !== 'string' || path.isAbsolute(filePath)) {
    throw new Error(`${label} output path must be a relative path under .revpack/outputs.`);
  }
  if (filePath.split(/[\\/]+/).includes('..')) {
    throw new Error(`${label} output path must not contain parent-directory traversal.`);
  }

  const resolved = path.resolve(workingDir, filePath);
  const relative = path.relative(expectedRoot, resolved);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} output path must resolve to a file under .revpack/outputs.`);
  }

  try {
    const realBundleRoot = await fs.realpath(path.resolve(workingDir, '.revpack'));
    const expectedRealRoot = path.join(realBundleRoot, 'outputs');
    const nearest = await nearestExistingRealPath(resolved);
    const physicalCandidate = path.resolve(nearest.real, path.relative(nearest.lexical, resolved));
    if (!isPathWithin(expectedRealRoot, physicalCandidate)) {
      throw new Error(`${label} output path resolves outside .revpack/outputs through an existing symlink.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('through an existing symlink')) throw error;
    throw new Error(`Could not validate ${label.toLowerCase()} output path ${resolved}.`, { cause: error });
  }
  return resolved;
}

async function loadBundleState(workingDir: string): Promise<BundleState> {
  const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
  let raw: string;
  try {
    raw = await fs.readFile(bundlePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('No active revpack bundle. Run `revpack prepare` first.', { cause: error });
    }
    throw new Error(`Could not read active review bundle at ${bundlePath}.`, { cause: error });
  }

  try {
    return JSON.parse(raw) as BundleState;
  } catch (error) {
    throw new Error(`Active review bundle at ${bundlePath} is not valid JSON.`, { cause: error });
  }
}

async function readOptionalFile(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw new Error(`Could not read ${filePath}.`, { cause: error });
  }
}

async function readOptionalJsonArray(filePath: string, label: string): Promise<unknown[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw new Error(`Could not read ${filePath}.`, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${filePath} must contain valid JSON.`, { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${filePath} must be a JSON array of ${label}.`);
  }
  return parsed.map((entry: unknown) => entry);
}

export async function assertPublishMaterialUnchanged(
  material: PublishMaterial,
  selection: PublishSelection,
): Promise<void> {
  const changed = (filePath: string): Error =>
    new Error(
      `${filePath} changed after publish material was loaded. ` +
        'Reopen Guided Publish and review the updated drafts before publishing.',
    );

  if (selection.replyIndexes.length > 0) {
    const currentReplies = await readOptionalJsonArray(material.repliesPath, 'reply objects');
    if (
      !isDeepStrictEqual(
        currentReplies,
        material.replies.map((draft) => draft.raw),
      )
    ) {
      throw changed(material.repliesPath);
    }
  }
  if (selection.findingIndexes.length > 0) {
    const currentFindings = await readOptionalJsonArray(material.findingsPath, 'finding objects');
    if (
      !isDeepStrictEqual(
        currentFindings,
        material.findings.map((draft) => draft.raw),
      )
    ) {
      throw changed(material.findingsPath);
    }
  }
  if (selection.summary && (await readOptionalFile(material.summary.path)) !== material.summary.content) {
    throw changed(material.summary.path);
  }
  if (selection.note && (await readOptionalFile(material.note.path)) !== material.note.content) {
    throw new Error(
      `${material.note.path} changed after publish material was loaded. ` +
        'Reopen Guided Publish and review the updated drafts before publishing.',
    );
  }
}

async function loadReplies(filePath: string): Promise<IndexedDraft<ReplyDraft>[]> {
  const rawEntries = await readOptionalJsonArray(filePath, 'reply objects');
  const parsed = repliesArraySchema.safeParse(rawEntries);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`${filePath} contains schema-invalid replies:\n${issues}`);
  }
  return parsed.data.map((value, index) => ({ index, value, raw: rawEntries[index] }));
}

async function loadFindings(
  filePath: string,
  patchPath: string,
): Promise<{ drafts: IndexedDraft<NewFinding>[]; contexts: Map<number, string> }> {
  const rawEntries = await readOptionalJsonArray(filePath, 'finding objects');
  const parsed = newFindingsArraySchema.safeParse(rawEntries);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('\n');
    throw new Error(`${filePath} contains schema-invalid findings:\n${issues}`);
  }
  if (parsed.data.length === 0) return { drafts: [], contexts: new Map() };

  let patchContent: string;
  try {
    patchContent = await fs.readFile(patchPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Cannot validate findings: ${patchPath} not found. Run \`revpack prepare\` first.`, {
        cause: error,
      });
    }
    throw new Error(`Could not read ${patchPath} while validating findings.`, { cause: error });
  }

  const lineMap = parsePatch(patchContent);
  const { errors } = validateFindings(parsed.data, lineMap);
  if (errors.length > 0) {
    throw new Error(
      `${errors.length} invalid finding(s) in ${filePath}. Fix the positions and retry.\n${formatValidationErrors(errors)}`,
    );
  }
  const drafts = parsed.data.map((value, index) => ({ index, value, raw: rawEntries[index] }));
  const contexts = new Map<number, string>();
  for (const draft of drafts) {
    const context = extractDiffContext(draft.value, lineMap);
    if (context) contexts.set(draft.index, context);
  }
  return { drafts, contexts };
}

async function loadReplyContexts(
  workingDir: string,
  bundleState: BundleState,
  replies: ReadonlyArray<IndexedDraft<ReplyDraft>>,
): Promise<Map<number, ReviewThread>> {
  const contexts = new Map<number, ReviewThread>();
  const bundleRoot = path.resolve(workingDir, '.revpack');
  const threadItems = bundleState.threads?.items ?? [];

  await Promise.all(
    replies.map(async (reply) => {
      const requested = reply.value.threadId.trim().toUpperCase();
      const item = threadItems.find(
        (candidate) =>
          candidate.shortId.toUpperCase() === requested ||
          candidate.providerThreadId.trim().toUpperCase() === requested,
      );
      if (!item) return;

      const contextPath = resolveWorkspacePath(workingDir, item.file);
      const relative = path.relative(bundleRoot, contextPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) return;
      try {
        const parsed = JSON.parse(await fs.readFile(contextPath, 'utf-8')) as unknown;
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          typeof (parsed as { threadId?: unknown }).threadId === 'string' &&
          Array.isArray((parsed as { comments?: unknown }).comments)
        ) {
          contexts.set(reply.index, parsed as ReviewThread);
        }
      } catch {
        // Reply publication remains valid even when its optional preview context is unavailable.
      }
    }),
  );
  return contexts;
}

function getCheckpointState(bundleState: BundleState): CheckpointPublishState {
  if (!bundleState.prepare.checkpoint) return 'none';
  const comparison = bundleState.prepare.comparison;
  const values = [
    comparison.targetCodeChangedSinceCheckpoint,
    comparison.threadsChangedSinceCheckpoint,
    comparison.descriptionChangedSinceCheckpoint,
  ];
  if (values.some((value) => value === true)) return 'outdated';
  if (values.every((value) => value === false)) return 'current';
  return 'unknown';
}

function getSummaryState(bundleState: BundleState, content: string): OutputState {
  if (!content.trim()) return 'empty';
  const publishedHash = bundleState.outputs.summary.lastPublishedHash;
  if (!publishedHash) return 'pending';
  return computeContentHash(content) === publishedHash ? 'published' : 'modified since publish';
}

export async function loadPublishMaterial(workingDir: string): Promise<PublishMaterial> {
  const bundleState = await loadBundleState(workingDir);
  const [summaryPath, notePath] = await Promise.all([
    resolveBundleOutputPath(workingDir, bundleState.outputs?.summary?.path, 'Summary'),
    resolveBundleOutputPath(workingDir, bundleState.outputs?.review?.path, 'Review note'),
  ]);
  const repliesPath = resolveWorkspacePath(workingDir, DEFAULT_PUBLISH_PATHS.replies);
  const findingsPath = resolveWorkspacePath(workingDir, DEFAULT_PUBLISH_PATHS.findings);
  const patchPath = resolveWorkspacePath(workingDir, DEFAULT_PUBLISH_PATHS.patch);
  const [summaryContent, noteContent, replies, loadedFindings] = await Promise.all([
    readOptionalFile(summaryPath),
    readOptionalFile(notePath),
    loadReplies(repliesPath),
    loadFindings(findingsPath, patchPath),
  ]);

  const replyContexts = await loadReplyContexts(workingDir, bundleState, replies);

  return {
    bundleState,
    findingsPath,
    repliesPath,
    findings: loadedFindings.drafts,
    findingContexts: loadedFindings.contexts,
    replies,
    replyContexts,
    summary: {
      path: summaryPath,
      state: getSummaryState(bundleState, summaryContent),
      content: summaryContent,
    },
    note: {
      path: notePath,
      state: noteContent.trim() ? 'pending' : 'empty',
      content: noteContent,
    },
    checkpointState: getCheckpointState(bundleState),
  };
}
