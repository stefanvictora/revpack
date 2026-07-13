import type { PublishSelection } from '../core/types.js';
import type { ReviewOrchestrator } from './orchestrator.js';
import {
  assertPublishMaterialUnchanged,
  clearPublishedDocument,
  removePublishedDrafts,
  type PublishMaterial,
} from '../workspace/publish-material.js';
import { renderPublishFindingBody } from '../workspace/finding-formatter.js';
import { mergeWithMarkers } from '../workspace/description-summary.js';
import { computeContentHash } from '../workspace/thread-digest.js';

export type PublishPlanItemKind = 'reply' | 'finding' | 'summary' | 'note' | 'checkpoint';

export interface PublishPlanItemResult {
  kind: PublishPlanItemKind;
  label: string;
  index?: number;
}

export interface PublishPlanFailure extends PublishPlanItemResult {
  error: string;
}

export interface PublishExecutionResult {
  successes: PublishPlanItemResult[];
  failures: PublishPlanFailure[];
  remainingReplies: number;
  remainingFindings: number;
  checkpoint: 'skipped' | 'published' | 'blocked' | 'failed';
  refresh: 'skipped' | 'succeeded' | 'failed';
  refreshError?: string;
}

export type PublishPlanProgress =
  | { type: 'section'; section: 'replies' | 'findings' | 'summary' | 'note' | 'checkpoint' | 'refresh' }
  | ({ type: 'success' } & PublishPlanItemResult)
  | ({ type: 'failure' } & PublishPlanFailure)
  | { type: 'info'; message: string };

export interface ExecutePublishPlanOptions {
  material: PublishMaterial;
  selection: PublishSelection;
  orchestrator: ReviewOrchestrator;
  repository: string;
  refresh: boolean;
  onProgress?: (event: PublishPlanProgress) => void;
}

export function selectAllPublishMaterial(material: PublishMaterial): PublishSelection {
  return {
    replyIndexes: material.replies.map((draft) => draft.index),
    findingIndexes: material.findings.map((draft) => draft.index),
    summary: material.summary.state === 'pending' || material.summary.state === 'modified since publish',
    note: material.note.state === 'pending',
    checkpoint: material.checkpointState !== 'current',
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateIndexes(label: string, indexes: readonly number[], available: ReadonlySet<number>): Set<number> {
  const selected = new Set(indexes);
  for (const index of selected) {
    if (!Number.isInteger(index) || !available.has(index)) {
      throw new Error(`Invalid ${label} selection index ${index}.`);
    }
  }
  return selected;
}

export async function executePublishPlan(options: ExecutePublishPlanOptions): Promise<PublishExecutionResult> {
  const { material, selection, orchestrator, repository, onProgress } = options;
  const selectedReplies = validateIndexes(
    'reply',
    selection.replyIndexes,
    new Set(material.replies.map((draft) => draft.index)),
  );
  const selectedFindings = validateIndexes(
    'finding',
    selection.findingIndexes,
    new Set(material.findings.map((draft) => draft.index)),
  );
  if (selection.note && material.note.state !== 'pending') {
    throw new Error('The selected review note is no longer pending.');
  }
  if (
    selection.summary &&
    material.summary.state !== 'pending' &&
    material.summary.state !== 'modified since publish'
  ) {
    throw new Error('The selected summary is no longer pending.');
  }
  await assertPublishMaterialUnchanged(material, selection);
  const successes: PublishPlanItemResult[] = [];
  const failures: PublishPlanFailure[] = [];
  const publishedReplyIndexes = new Set<number>();
  const publishedFindingIndexes = new Set<number>();
  let expectedReplyEntries = material.replies.map((draft) => draft.raw);
  let expectedFindingEntries = material.findings.map((draft) => draft.raw);

  if (selectedReplies.size > 0) onProgress?.({ type: 'section', section: 'replies' });
  for (const reply of material.replies) {
    if (!selectedReplies.has(reply.index)) continue;
    const item = { kind: 'reply' as const, index: reply.index, label: reply.value.threadId };
    try {
      await orchestrator.publishReply(undefined, reply.value.threadId, reply.value.body, repository);
      const nextPublishedIndexes = new Set(publishedReplyIndexes).add(reply.index);
      await removePublishedDrafts(material.repliesPath, material.replies, nextPublishedIndexes, {
        deleteWhenEmpty: true,
        expectedEntries: expectedReplyEntries,
      });
      publishedReplyIndexes.add(reply.index);
      expectedReplyEntries = material.replies
        .filter((draft) => !nextPublishedIndexes.has(draft.index))
        .map((draft) => draft.raw);
      const tracked = await orchestrator.workspace.appendPublishedAction({
        type: 'reply',
        providerThreadId: reply.value.threadId,
        title: reply.value.body.split('\n')[0].slice(0, 80),
        publishedAt: new Date().toISOString(),
      });
      if (!tracked) throw new Error(`Could not record the published reply ${reply.value.threadId}.`);
      if (reply.value.resolve) {
        await orchestrator.resolveThread(undefined, reply.value.threadId, repository);
        const resolutionTracked = await orchestrator.workspace.appendPublishedAction({
          type: 'resolve',
          providerThreadId: reply.value.threadId,
          title: 'Thread resolved',
          publishedAt: new Date().toISOString(),
        });
        if (!resolutionTracked) throw new Error(`Could not record the resolved thread ${reply.value.threadId}.`);
        onProgress?.({ type: 'info', message: `${reply.value.threadId} resolved.` });
      }
      successes.push(item);
      onProgress?.({ type: 'success', ...item });
    } catch (error) {
      const detail = errorMessage(error);
      const failure = {
        ...item,
        error: publishedReplyIndexes.has(reply.index)
          ? `${detail} (the reply was published and removed from the queue; resolution will not be retried automatically)`
          : detail,
      };
      failures.push(failure);
      onProgress?.({ type: 'failure', ...failure });
    }
  }

  if (selectedFindings.size > 0) onProgress?.({ type: 'section', section: 'findings' });
  let noteHandledInBatch = false;
  if (material.bundleState.target.provider === 'github' && selectedFindings.size > 0) {
    const findings = material.findings.filter((finding) => selectedFindings.has(finding.index));
    const annotated = findings.map((finding) => ({
      ...finding.value,
      body: renderPublishFindingBody(finding.value),
    }));
    noteHandledInBatch = selection.note;
    let batchResult: Awaited<ReturnType<ReviewOrchestrator['publishReviewBatch']>>;
    try {
      batchResult = await orchestrator.publishReviewBatch(
        annotated,
        selection.note ? material.note.content : '',
        repository,
      );
      if (!batchResult.created) throw new Error('The provider did not create the selected review batch.');
    } catch (error) {
      for (const finding of findings) {
        const displayPath = finding.value.newPath || finding.value.oldPath;
        const line = finding.value.newLine ?? finding.value.oldLine;
        const failure = {
          kind: 'finding' as const,
          index: finding.index,
          label: `${displayPath}:${line}`,
          error: errorMessage(error),
        };
        failures.push(failure);
        onProgress?.({ type: 'failure', ...failure });
      }
      if (selection.note) {
        const failure = { kind: 'note' as const, label: 'Review note', error: errorMessage(error) };
        failures.push(failure);
        onProgress?.({ type: 'failure', ...failure });
      }
      batchResult = { created: false };
    }

    if (batchResult.created) {
      let findingsCleanupError: string | undefined;
      try {
        await removePublishedDrafts(material.findingsPath, material.findings, selectedFindings, {
          deleteWhenEmpty: true,
          expectedEntries: expectedFindingEntries,
        });
        for (const finding of findings) publishedFindingIndexes.add(finding.index);
        expectedFindingEntries = material.findings
          .filter((draft) => !selectedFindings.has(draft.index))
          .map((draft) => draft.raw);
      } catch (error) {
        findingsCleanupError = errorMessage(error);
      }

      let noteCleanupError: string | undefined;
      if (selection.note) {
        try {
          await clearPublishedDocument(material.note.path, material.note.content);
        } catch (error) {
          noteCleanupError = errorMessage(error);
        }
      }

      const threadIds = batchResult.threadIds ?? [];
      for (let index = 0; index < findings.length; index++) {
        const finding = findings[index];
        const published = annotated[index];
        const displayPath = finding.value.newPath || finding.value.oldPath;
        const line = finding.value.newLine ?? finding.value.oldLine;
        const item = { kind: 'finding' as const, index: finding.index, label: `${displayPath}:${line}` };
        const itemErrors = findingsCleanupError ? [findingsCleanupError] : [];
        try {
          const providerThreadId = threadIds[index];
          const tracked = await orchestrator.workspace.appendPublishedAction({
            type: 'finding',
            ...(typeof providerThreadId === 'string' ? { providerThreadId } : {}),
            location: {
              oldPath: published.oldPath,
              newPath: published.newPath,
              oldLine: published.oldLine,
              newLine: published.newLine,
            },
            severity: published.severity,
            category: published.category,
            title: finding.value.body.split('\n')[0].slice(0, 80),
            publishedAt: new Date().toISOString(),
          });
          if (!tracked) throw new Error(`Could not record the published finding at index ${finding.index}.`);
        } catch (error) {
          itemErrors.push(errorMessage(error));
        }

        if (itemErrors.length > 0) {
          const failure = { ...item, error: itemErrors.join(' ') };
          failures.push(failure);
          onProgress?.({ type: 'failure', ...failure });
        } else {
          successes.push(item);
          onProgress?.({ type: 'success', ...item });
        }
      }

      if (selection.note) {
        const item = { kind: 'note' as const, label: 'Review note' };
        if (noteCleanupError) {
          const failure = { ...item, error: noteCleanupError };
          failures.push(failure);
          onProgress?.({ type: 'failure', ...failure });
        } else {
          successes.push(item);
          onProgress?.({ type: 'success', ...item });
        }
      }
    }
  } else if (material.bundleState.target.provider !== 'github') {
    for (const finding of material.findings) {
      if (!selectedFindings.has(finding.index)) continue;
      const displayPath = finding.value.newPath || finding.value.oldPath;
      const line = finding.value.newLine ?? finding.value.oldLine;
      const item = { kind: 'finding' as const, index: finding.index, label: `${displayPath}:${line}` };
      try {
        const annotated = { ...finding.value, body: renderPublishFindingBody(finding.value) };
        const createdThreadId = await orchestrator.publishFinding(annotated, repository);
        const nextPublishedIndexes = new Set(publishedFindingIndexes).add(finding.index);
        await removePublishedDrafts(material.findingsPath, material.findings, nextPublishedIndexes, {
          deleteWhenEmpty: true,
          expectedEntries: expectedFindingEntries,
        });
        publishedFindingIndexes.add(finding.index);
        expectedFindingEntries = material.findings
          .filter((draft) => !nextPublishedIndexes.has(draft.index))
          .map((draft) => draft.raw);
        const tracked = await orchestrator.workspace.appendPublishedAction({
          type: 'finding',
          providerThreadId: createdThreadId,
          location: {
            oldPath: finding.value.oldPath,
            newPath: finding.value.newPath,
            oldLine: finding.value.oldLine,
            newLine: finding.value.newLine,
          },
          severity: finding.value.severity,
          category: finding.value.category,
          title: finding.value.body.split('\n')[0].slice(0, 80),
          publishedAt: new Date().toISOString(),
        });
        if (!tracked) throw new Error(`Could not record the published finding at index ${finding.index}.`);
        successes.push(item);
        onProgress?.({ type: 'success', ...item });
      } catch (error) {
        const failure = { ...item, error: errorMessage(error) };
        failures.push(failure);
        onProgress?.({ type: 'failure', ...failure });
      }
    }
  }

  if (selection.summary) {
    onProgress?.({ type: 'section', section: 'summary' });
    const item = { kind: 'summary' as const, label: 'Summary' };
    try {
      const target = await orchestrator.open(undefined, repository);
      const description = mergeWithMarkers(target.description, material.summary.content, {
        markerStyle: material.bundleState.target.provider === 'bitbucket-cloud' ? 'markdown-heading' : 'html',
      });
      await orchestrator.updateDescription(undefined, description, repository);
      const tracked = await orchestrator.workspace.updateOutputPublishState(
        'summary',
        computeContentHash(material.summary.content),
        target.diffRefs.headSha,
      );
      if (!tracked) throw new Error('Could not record the selected summary publish state.');
      successes.push(item);
      onProgress?.({ type: 'success', ...item });
    } catch (error) {
      const failure = { ...item, error: errorMessage(error) };
      failures.push(failure);
      onProgress?.({ type: 'failure', ...failure });
    }
  }

  if (selection.note && !noteHandledInBatch) {
    onProgress?.({ type: 'section', section: 'note' });
    const item = { kind: 'note' as const, label: 'Review note' };
    try {
      const result = await orchestrator.publishReview(material.note.content, repository);
      if (!result.created) throw new Error('The provider did not create the selected review note.');
      await clearPublishedDocument(material.note.path, material.note.content);
      successes.push(item);
      onProgress?.({ type: 'success', ...item });
    } catch (error) {
      const failure = { ...item, error: errorMessage(error) };
      failures.push(failure);
      onProgress?.({ type: 'failure', ...failure });
    }
  }

  let checkpoint: PublishExecutionResult['checkpoint'] = 'skipped';
  if (selection.checkpoint) {
    onProgress?.({ type: 'section', section: 'checkpoint' });
    if (failures.length > 0) {
      checkpoint = 'blocked';
      onProgress?.({ type: 'info', message: 'Checkpoint skipped because selected review material failed.' });
    } else {
      try {
        await orchestrator.publishCheckpoint(repository);
        checkpoint = 'published';
        const item = { kind: 'checkpoint' as const, label: 'Checkpoint' };
        successes.push(item);
        onProgress?.({ type: 'success', ...item });
      } catch (error) {
        checkpoint = 'failed';
        const failure = { kind: 'checkpoint' as const, label: 'Checkpoint', error: errorMessage(error) };
        failures.push(failure);
        onProgress?.({ type: 'failure', ...failure });
      }
    }
  }

  let refresh: PublishExecutionResult['refresh'] = 'skipped';
  let refreshError: string | undefined;
  const hasSelectedAction =
    selectedReplies.size > 0 ||
    selection.findingIndexes.length > 0 ||
    selection.summary ||
    selection.note ||
    selection.checkpoint;
  if (options.refresh && hasSelectedAction && failures.length === 0) {
    onProgress?.({ type: 'section', section: 'refresh' });
    try {
      await orchestrator.prepare(undefined, repository, { preservePendingOutputs: true });
      refresh = 'succeeded';
      onProgress?.({ type: 'info', message: 'Bundle refreshed.' });
    } catch (error) {
      refresh = 'failed';
      refreshError = errorMessage(error);
      onProgress?.({ type: 'info', message: `Bundle refresh failed: ${refreshError}` });
    }
  }

  return {
    successes,
    failures,
    remainingReplies: material.replies.length - publishedReplyIndexes.size,
    remainingFindings: material.findings.length - publishedFindingIndexes.size,
    checkpoint,
    refresh,
    ...(refreshError ? { refreshError } : {}),
  };
}
