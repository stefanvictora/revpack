import type {
  NewFinding,
  OutputState,
  ProviderType,
  PublishSelection,
  ReplyDraft,
  ReviewThread,
} from '../../core/types.js';
import chalk from 'chalk';
import { emitKeypressEvents } from 'node:readline';

export type PublishTerminalKey =
  | 'up'
  | 'down'
  | 'space'
  | 'toggle-group'
  | 'page-up'
  | 'page-down'
  | 'enter'
  | 'escape'
  | 'interrupt'
  | 'resize'
  | 'other';

export interface PublishTerminal {
  readonly interactive: boolean;
  dimensions(): { columns: number; rows: number };
  start(): void | Promise<void>;
  stop(): void | Promise<void>;
  readKey(): Promise<PublishTerminalKey>;
  writeFrame(frame: string): void;
}

interface KeypressDetails {
  name?: string;
  ctrl?: boolean;
}

function decodeNodeKey(value: string | undefined, key: KeypressDetails | undefined): PublishTerminalKey {
  if (key?.ctrl && key.name === 'c') return 'interrupt';
  switch (key?.name) {
    case 'up':
      return 'up';
    case 'down':
      return 'down';
    case 'pageup':
      return 'page-up';
    case 'pagedown':
      return 'page-down';
    case 'return':
    case 'enter':
      return 'enter';
    case 'escape':
      return 'escape';
    case 'space':
      return 'space';
  }
  if (value === ' ') return 'space';
  if (value === 'a') return 'toggle-group';
  return 'other';
}

class NodePublishTerminal implements PublishTerminal {
  readonly interactive: boolean;
  private started = false;
  private wasRaw = false;
  private shouldPauseOnStop = false;
  private alternateScreen = false;

  constructor(
    private readonly input: NodeJS.ReadStream,
    private readonly output: NodeJS.WriteStream,
  ) {
    this.interactive = input.isTTY === true && output.isTTY === true;
  }

  dimensions(): { columns: number; rows: number } {
    return {
      columns: Math.max(20, this.output.columns || 80),
      rows: Math.max(8, this.output.rows || 24),
    };
  }

  start(): void {
    if (this.started) return;
    this.wasRaw = this.input.isRaw === true;
    this.shouldPauseOnStop = this.input.readableFlowing !== true;
    this.started = true;
    try {
      emitKeypressEvents(this.input);
      this.input.setRawMode?.(true);
      this.input.resume();
      this.alternateScreen = true;
      this.output.write('\u001b[?1049h');
      this.output.write('\u001b[?25l');
    } catch (error) {
      this.started = false;
      try {
        this.input.setRawMode?.(this.wasRaw);
      } catch {
        // Preserve the startup error while making every cleanup step best-effort.
      }
      try {
        if (this.shouldPauseOnStop) this.input.pause();
      } catch {
        // Preserve the startup error while making every cleanup step best-effort.
      }
      try {
        this.output.write('\u001b[?25h');
      } catch {
        // Preserve the startup error even when the output stream is also failing.
      }
      if (this.alternateScreen) {
        try {
          this.output.write('\u001b[?1049l');
        } catch {
          // Preserve the startup error even when restoring the screen also fails.
        } finally {
          this.alternateScreen = false;
        }
      }
      throw error;
    }
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.input.setRawMode?.(this.wasRaw);
    } finally {
      try {
        if (this.shouldPauseOnStop) this.input.pause();
      } finally {
        try {
          this.output.write('\u001b[?25h');
        } finally {
          try {
            this.output.write('\u001b[?1049l');
          } finally {
            this.alternateScreen = false;
          }
        }
      }
    }
  }

  readKey(): Promise<PublishTerminalKey> {
    return new Promise((resolve) => {
      const finish = (key: PublishTerminalKey): void => {
        this.input.off('keypress', onKeypress);
        this.output.off('resize', onResize);
        resolve(key);
      };
      const onKeypress = (value: string | undefined, key: KeypressDetails | undefined): void => {
        finish(decodeNodeKey(value, key));
      };
      const onResize = (): void => {
        finish('resize');
      };
      this.input.once('keypress', onKeypress);
      this.output.once('resize', onResize);
    });
  }

  writeFrame(frame: string): void {
    this.output.write(`\u001b[2J\u001b[H${frame}`);
  }
}

export function createNodePublishTerminal(
  streams: { input?: NodeJS.ReadStream; output?: NodeJS.WriteStream } = {},
): PublishTerminal {
  return new NodePublishTerminal(streams.input ?? process.stdin, streams.output ?? process.stdout);
}

export interface GuidedPublishModel {
  provider: ProviderType;
  findings: ReadonlyArray<{ index: number; value: NewFinding }>;
  findingContexts: ReadonlyMap<number, string>;
  replies: ReadonlyArray<{ index: number; value: ReplyDraft }>;
  replyContexts: ReadonlyMap<number, ReviewThread>;
  summary: { state: OutputState; content: string };
  note: { content: string };
  checkpoint: {
    state: 'none' | 'current' | 'outdated' | 'unknown';
    targetHeadSha: string;
  };
}

const NON_INTERACTIVE_MESSAGE =
  'Interactive publishing requires a terminal.\n' +
  'Use `revpack publish all` or a specific `revpack publish <command>` in scripts.';

function requireInteractive(terminal: PublishTerminal): void {
  if (!terminal.interactive) throw new Error(NON_INTERACTIVE_MESSAGE);
}

function skipCsiSequence(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) return index;
    if (code >= 0x40 && code <= 0x7e) return index + 1;
  }
  return value.length;
}

function skipControlString(value: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 10) return index;
    if (code === 7 || code === 0x9c) return index + 1;
    if (code === 27 && value.charCodeAt(index + 1) === 0x5c) return index + 2;
  }
  return value.length;
}

function sanitizeTerminalText(value: string): string {
  let sanitized = '';
  let index = 0;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 10) {
      sanitized += '\n';
      index += 1;
      continue;
    }
    if (code === 9) {
      sanitized += '  ';
      index += 1;
      continue;
    }
    if (code === 27) {
      const next = value.charCodeAt(index + 1);
      if (next === 0x5b) index = skipCsiSequence(value, index + 2);
      else if (next === 0x5d || next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
        index = skipControlString(value, index + 2);
      } else index += index + 1 < value.length ? 2 : 1;
      continue;
    }
    if (code === 0x9b) {
      index = skipCsiSequence(value, index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = skipControlString(value, index + 1);
      continue;
    }
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      index += 1;
      continue;
    }
    sanitized += value[index];
    index += 1;
  }
  return sanitized;
}

function sanitizeGuidedPublishModel(model: GuidedPublishModel): GuidedPublishModel {
  return {
    ...model,
    findings: model.findings.map(({ index, value }) => ({
      index,
      value: {
        ...value,
        oldPath: sanitizeTerminalText(value.oldPath),
        newPath: sanitizeTerminalText(value.newPath),
        body: sanitizeTerminalText(value.body),
        category: sanitizeTerminalText(value.category),
      },
    })),
    findingContexts: new Map(
      [...model.findingContexts].map(([index, context]) => [index, sanitizeTerminalText(context)]),
    ),
    replies: model.replies.map(({ index, value }) => ({
      index,
      value: {
        ...value,
        threadId: sanitizeTerminalText(value.threadId),
        body: sanitizeTerminalText(value.body),
      },
    })),
    replyContexts: new Map(
      [...model.replyContexts].map(([index, context]) => [
        index,
        {
          ...context,
          threadId: sanitizeTerminalText(context.threadId),
          position: context.position
            ? {
                ...context.position,
                filePath: sanitizeTerminalText(context.position.filePath),
                oldPath:
                  context.position.oldPath === undefined ? undefined : sanitizeTerminalText(context.position.oldPath),
                newPath:
                  context.position.newPath === undefined ? undefined : sanitizeTerminalText(context.position.newPath),
              }
            : undefined,
          comments: context.comments.map((comment) => ({
            ...comment,
            author: sanitizeTerminalText(comment.author),
            body: sanitizeTerminalText(comment.body),
          })),
        },
      ]),
    ),
    summary: { ...model.summary, content: sanitizeTerminalText(model.summary.content) },
    note: { content: sanitizeTerminalText(model.note.content) },
    checkpoint: {
      ...model.checkpoint,
      targetHeadSha: sanitizeTerminalText(model.checkpoint.targetHeadSha),
    },
  };
}

interface SelectionState {
  findingIndexes: Set<number>;
  replyIndexes: Set<number>;
  summary: boolean;
  note: boolean;
  checkpoint: boolean;
  checkpointExplicit: boolean;
}

type FocusTarget =
  | { kind: 'finding-group'; group: 'findings' }
  | { kind: 'finding'; group: 'findings'; index: number }
  | { kind: 'reply-group'; group: 'replies' }
  | { kind: 'reply'; group: 'replies'; index: number }
  | { kind: 'summary'; group: 'documents' }
  | { kind: 'note'; group: 'documents' }
  | { kind: 'checkpoint'; group: 'review-state' };

function initialSelection(model: GuidedPublishModel): SelectionState {
  return {
    findingIndexes: new Set(model.findings.map((finding) => finding.index)),
    replyIndexes: new Set(model.replies.map((reply) => reply.index)),
    summary: model.summary.state === 'pending' || model.summary.state === 'modified since publish',
    note: model.note.content.trim().length > 0,
    checkpoint: model.checkpoint.state !== 'current',
    checkpointExplicit: false,
  };
}

function toPublishSelection(model: GuidedPublishModel, selection: SelectionState): PublishSelection {
  return {
    findingIndexes: model.findings
      .filter((finding) => selection.findingIndexes.has(finding.index))
      .map((finding) => finding.index),
    replyIndexes: model.replies.filter((reply) => selection.replyIndexes.has(reply.index)).map((reply) => reply.index),
    summary: selection.summary,
    note: selection.note,
    checkpoint: selection.checkpoint,
  };
}

function focusTargets(model: GuidedPublishModel): FocusTarget[] {
  const targets: FocusTarget[] = [];
  if (model.findings.length > 0) {
    targets.push({ kind: 'finding-group', group: 'findings' });
    targets.push(
      ...model.findings.map(({ index }) => ({ kind: 'finding' as const, group: 'findings' as const, index })),
    );
  }
  if (model.replies.length > 0) {
    targets.push({ kind: 'reply-group', group: 'replies' });
    targets.push(...model.replies.map(({ index }) => ({ kind: 'reply' as const, group: 'replies' as const, index })));
  }
  if (model.summary.state === 'pending' || model.summary.state === 'modified since publish') {
    targets.push({ kind: 'summary', group: 'documents' });
  }
  if (model.note.content.trim()) targets.push({ kind: 'note', group: 'documents' });
  if (model.checkpoint.state !== 'current') targets.push({ kind: 'checkpoint', group: 'review-state' });
  return targets;
}

function groupMarker(selected: number, total: number): string {
  if (total === 0 || selected === 0) return '[ ]';
  return selected === total ? '[x]' : '[-]';
}

function deferredDraftCount(model: GuidedPublishModel, selection: SelectionState): number {
  return model.findings.length - selection.findingIndexes.size + model.replies.length - selection.replyIndexes.size;
}

function unpublishedDocuments(model: GuidedPublishModel, selection: SelectionState): string[] {
  const documents: string[] = [];
  const summaryPending = model.summary.state === 'pending' || model.summary.state === 'modified since publish';
  if (summaryPending && !selection.summary) documents.push('Summary');
  if (model.note.content.trim() && !selection.note) documents.push('Review note');
  return documents;
}

function joinWithAnd(values: readonly string[]): string {
  if (values.length < 2) return values[0] ?? '';
  return `${values.slice(0, -1).join(', ')} and ${values.at(-1)}`;
}

function checkpointWarning(model: GuidedPublishModel, selection: SelectionState): string | null {
  const drafts = deferredDraftCount(model, selection);
  const documents = unpublishedDocuments(model, selection);
  if (!selection.checkpoint || !selection.checkpointExplicit || (drafts === 0 && documents.length === 0)) return null;
  if (documents.length === 0) {
    return `Warning: the checkpoint will be recorded while ${drafts} ${
      drafts === 1 ? 'draft remains' : 'drafts remain'
    } unpublished.`;
  }
  const remaining = [...(drafts > 0 ? [`${drafts} ${drafts === 1 ? 'draft' : 'drafts'}`] : []), ...documents];
  return `Warning: the checkpoint will be recorded while ${joinWithAnd(remaining)} ${
    drafts + documents.length === 1 ? 'remains' : 'remain'
  } unpublished.`;
}

function wrapText(text: string, width: number): string[] {
  const safeWidth = Math.max(10, width);
  const result: string[] = [];
  for (const sourceLine of text.replace(/\r\n/g, '\n').split('\n')) {
    if (sourceLine.length <= safeWidth) {
      result.push(sourceLine);
      continue;
    }
    let remaining = sourceLine;
    while (remaining.length > safeWidth) {
      const candidate = remaining.slice(0, safeWidth + 1);
      const breakAt = candidate.lastIndexOf(' ');
      const end = breakAt > 0 ? breakAt : safeWidth;
      result.push(remaining.slice(0, end));
      remaining = remaining.slice(end).replace(/^ /, '');
    }
    result.push(remaining);
  }
  return result;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, 'g');

function visibleText(value: string): string {
  return value.replace(ANSI_PATTERN, '');
}

function fitColumn(value: string, width: number): string {
  const visible = visibleText(value);
  if (visible.length > width) return visible.slice(0, Math.max(0, width - 1)) + (width > 0 ? '…' : '');
  return value + ' '.repeat(width - visible.length);
}

function truncateColumn(value: string, width: number): string {
  const visible = visibleText(value);
  if (visible.length <= width) return value;
  return visible.slice(0, Math.max(0, width - 1)) + (width > 0 ? '…' : '');
}

function focusedLineIndex(lines: readonly string[]): number {
  return lines.findIndex((line) => /^\s*> /.test(visibleText(line)) || /^\s{2}> /.test(visibleText(line)));
}

function visibleListLines(lines: readonly string[], height: number): string[] {
  if (lines.length === 0 || height <= 0) return [];
  if (lines.length <= height) return [...lines];
  const header = lines[0];
  const body = lines.slice(1);
  const bodyHeight = Math.max(1, height - 1);
  const focused = Math.max(0, focusedLineIndex(lines) - 1);
  const start = Math.min(Math.max(0, focused - bodyHeight + 1), Math.max(0, body.length - bodyHeight));
  return [header, ...body.slice(start, start + bodyHeight)];
}

function severityHeading(severity: NewFinding['severity'], category: string, width: number): string[] {
  const heading = wrapText(`${severity.toUpperCase()} · ${category}`, width);
  switch (severity) {
    case 'blocker':
    case 'high':
      return heading.map((line) => chalk.red.bold(line));
    case 'medium':
      return heading.map((line) => chalk.yellow.bold(line));
    case 'low':
      return heading.map((line) => chalk.blue.bold(line));
    case 'nit':
      return heading.map((line) => chalk.gray.bold(line));
  }
}

function boldWrapped(text: string, width: number): string[] {
  return wrapText(text, width).map((line) => chalk.bold(line));
}

function dimWrapped(text: string, width: number): string[] {
  return wrapText(text, width).map((line) => chalk.dim(line));
}

function warningWrapped(text: string, width: number): string[] {
  return wrapText(text, width).map((line) => chalk.yellow(line));
}

const REPLY_CONTEXT_MAX_CHARACTERS = 500;
const REPLY_CONTEXT_MAX_LINES = 6;

function compactReplyContext(text: string, width: number): string[] {
  const normalized = text.trim();
  let excerpt = normalized;
  if (excerpt.length > REPLY_CONTEXT_MAX_CHARACTERS) {
    const candidate = excerpt.slice(0, REPLY_CONTEXT_MAX_CHARACTERS - 1).trimEnd();
    const lastWhitespace = Math.max(candidate.lastIndexOf(' '), candidate.lastIndexOf('\n'));
    excerpt = `${
      lastWhitespace >= Math.floor(REPLY_CONTEXT_MAX_CHARACTERS * 0.75)
        ? candidate.slice(0, lastWhitespace).trimEnd()
        : candidate
    }…`;
  }

  const lines = wrapText(excerpt || '(empty comment)', Math.max(10, width - 2));
  const visibleLines =
    lines.length <= REPLY_CONTEXT_MAX_LINES ? lines : [...lines.slice(0, REPLY_CONTEXT_MAX_LINES - 1), '…'];
  return visibleLines.map((line) => (line ? `> ${line}` : '>'));
}

function authorMention(author: string): string {
  return author.startsWith('@') ? author : `@${author}`;
}

function renderPreview(
  model: GuidedPublishModel,
  selection: SelectionState,
  focus: FocusTarget | undefined,
  width: number,
): string[] {
  if (focus?.kind === 'finding') {
    const finding = model.findings.find(({ index }) => index === focus.index)?.value;
    if (!finding) return [];
    const context = model.findingContexts.get(focus.index);
    const positions = [
      finding.oldLine === undefined ? null : `old line ${finding.oldLine}`,
      finding.newLine === undefined ? null : `new line ${finding.newLine}`,
    ].filter((position): position is string => position !== null);
    const path = finding.oldPath === finding.newPath ? finding.newPath : `${finding.oldPath} → ${finding.newPath}`;
    return [
      ...severityHeading(finding.severity, finding.category, width),
      ...dimWrapped(`${path} · ${positions.join(', ') || 'position unavailable'}`, width),
      ...(context ? ['', ...wrapText(context, width)] : []),
      '',
      ...wrapText(finding.body, width),
    ];
  }
  if (focus?.kind === 'finding-group') {
    return [
      ...boldWrapped('Findings', width),
      ...wrapText(`${selection.findingIndexes.size} of ${model.findings.length} findings selected.`, width),
    ];
  }
  if (focus?.kind === 'reply') {
    const reply = model.replies.find(({ index }) => index === focus.index)?.value;
    if (!reply) return [];
    const context = model.replyContexts.get(focus.index);
    const contextPosition = context?.position
      ? `${context.position.filePath}${
          (context.position.newLine ?? context.position.oldLine) === undefined
            ? ''
            : `:${context.position.newLine ?? context.position.oldLine}`
        }`
      : null;
    const originalComment = context?.comments[0];
    return [
      ...boldWrapped(`Reply ${reply.threadId}${reply.resolve ? ' · resolves thread' : ''}`, width),
      ...(contextPosition ? dimWrapped(contextPosition, width) : []),
      '',
      ...(originalComment
        ? [
            ...dimWrapped(`In reply to ${authorMention(originalComment.author)}:`, width),
            '',
            ...compactReplyContext(originalComment.body, width),
          ]
        : dimWrapped(`Thread context unavailable for ${reply.threadId}.`, width)),
      '',
      ...wrapText(reply.body, width),
    ];
  }
  if (focus?.kind === 'reply-group') {
    return [
      ...boldWrapped('Replies', width),
      ...wrapText(`${selection.replyIndexes.size} of ${model.replies.length} replies selected.`, width),
    ];
  }
  if (focus?.kind === 'summary') {
    return [
      ...boldWrapped('Summary', width),
      ...dimWrapped('Updates the managed PR/MR description section.', width),
      '',
      ...wrapText(model.summary.content, width),
    ];
  }
  if (focus?.kind === 'note') {
    const delivery =
      model.provider === 'github' && selection.findingIndexes.size > 0
        ? 'Included in the GitHub review with selected findings.'
        : 'Creates a target-level review note.';
    return [
      ...boldWrapped('Review note', width),
      ...dimWrapped(delivery, width),
      '',
      ...wrapText(model.note.content, width),
    ];
  }
  if (focus?.kind === 'checkpoint') {
    const drafts = deferredDraftCount(model, selection);
    const documents = unpublishedDocuments(model, selection);
    const warning = checkpointWarning(model, selection);
    const state =
      model.checkpoint.state === 'none'
        ? 'not recorded'
        : model.checkpoint.state === 'outdated'
          ? 'needs update'
          : model.checkpoint.state;
    return [
      ...boldWrapped('Checkpoint', width),
      ...wrapText(
        `Target head: ${model.checkpoint.targetHeadSha ? model.checkpoint.targetHeadSha.slice(0, 8) : '<unknown>'}`,
        width,
      ),
      ...wrapText(`Current state: ${state}`, width),
      ...wrapText(`Drafts remaining: ${drafts}`, width),
      ...(documents.length > 0 ? wrapText(`Unpublished documents: ${joinWithAnd(documents)}`, width) : []),
      ...(warning ? ['', ...warningWrapped(warning, width)] : []),
    ];
  }
  return [];
}

interface SelectionLayout {
  wide: boolean;
  listWidth: number;
  previewWidth: number;
  availableHeight: number;
  listHeight: number;
  previewHeight: number;
}

const SELECTION_KEY_HELP = '↑↓ navigate  Space toggle  a toggle group  PgUp/PgDn preview  Enter continue  Esc cancel';

function selectionFooterLines(model: GuidedPublishModel, selection: SelectionState, columns: number): string[] {
  const selectedCount =
    selection.findingIndexes.size +
    selection.replyIndexes.size +
    Number(selection.summary) +
    Number(selection.note) +
    Number(selection.checkpoint);
  const deferredDrafts = deferredDraftCount(model, selection);
  const warning = checkpointWarning(model, selection);
  return [
    '',
    ...wrapText(
      `${selectedCount} items selected • ${deferredDrafts} ${deferredDrafts === 1 ? 'draft' : 'drafts'} will remain`,
      columns,
    ),
    ...(warning ? warningWrapped(warning, columns) : []),
    ...dimWrapped(SELECTION_KEY_HELP, columns),
  ];
}

function selectionLayout(
  dimensions: { columns: number; rows: number },
  footerHeight: number,
  showPreviewHeading: boolean,
): SelectionLayout {
  const wide = dimensions.columns >= 100;
  const listWidth = wide ? Math.min(52, Math.max(36, Math.floor(dimensions.columns * 0.42))) : dimensions.columns;
  const previewWidth = wide ? Math.max(20, dimensions.columns - listWidth - 3) : Math.max(20, dimensions.columns - 2);
  const availableHeight = Math.max(6, dimensions.rows - footerHeight);
  const previewChromeHeight = (wide ? 0 : 1) + Number(showPreviewHeading);
  const listHeight = wide
    ? availableHeight
    : Math.min(availableHeight - previewChromeHeight - 1, Math.max(4, Math.ceil(availableHeight * 0.55)));
  const previewHeight = Math.max(1, availableHeight - (wide ? 0 : listHeight) - previewChromeHeight);
  return { wide, listWidth, previewWidth, availableHeight, listHeight, previewHeight };
}

function showPreviewHeading(focus: FocusTarget | undefined): boolean {
  return focus?.kind !== 'finding-group' && focus?.kind !== 'reply-group';
}

function maximumPreviewOffset(
  model: GuidedPublishModel,
  selection: SelectionState,
  focus: FocusTarget | undefined,
  dimensions: { columns: number; rows: number },
): number {
  const footerLines = selectionFooterLines(model, selection, dimensions.columns);
  const layout = selectionLayout(dimensions, footerLines.length, showPreviewHeading(focus));
  return Math.max(0, renderPreview(model, selection, focus, layout.previewWidth).length - layout.previewHeight);
}

function dimWhenDisabled(value: string, disabled: boolean): string {
  return disabled ? chalk.dim(value) : value;
}

function focusMarker(focused: boolean): string {
  return focused ? '> ' : '  ';
}

function renderSelection(
  model: GuidedPublishModel,
  selection: SelectionState,
  focus: FocusTarget | undefined,
  dimensions: { columns: number; rows: number },
  previewOffset: number,
): string {
  const summaryDetail =
    model.summary.state === 'empty' ? 'none' : model.summary.state === 'published' ? 'current' : model.summary.state;
  const notePending = model.note.content.trim().length > 0;
  const checkpointDue = model.checkpoint.state !== 'current';

  const materialLines = [
    'Review material',
    dimWhenDisabled(
      `${focusMarker(focus?.kind === 'finding-group')}${groupMarker(selection.findingIndexes.size, model.findings.length)} Findings — ${
        model.findings.length === 0 ? 'none' : `${selection.findingIndexes.size}/${model.findings.length} selected`
      }`,
      model.findings.length === 0,
    ),
    ...model.findings.map(({ index, value }) => {
      const position = value.newLine ?? value.oldLine ?? '?';
      const label = value.body.split('\n')[0] || '(untitled finding)';
      return `  ${focusMarker(focus?.kind === 'finding' && focus.index === index)}${
        selection.findingIndexes.has(index) ? '[x]' : '[ ]'
      } ${value.newPath}:${position} ${label}`;
    }),
    dimWhenDisabled(
      `${focusMarker(focus?.kind === 'reply-group')}${groupMarker(selection.replyIndexes.size, model.replies.length)} Replies — ${
        model.replies.length === 0 ? 'none' : `${selection.replyIndexes.size}/${model.replies.length} selected`
      }`,
      model.replies.length === 0,
    ),
    ...model.replies.map(
      ({ index, value }) =>
        `  ${focusMarker(focus?.kind === 'reply' && focus.index === index)}${
          selection.replyIndexes.has(index) ? '[x]' : '[ ]'
        } ${value.threadId} ${value.body.split('\n')[0] || '(empty reply)'}`,
    ),
    '',
    'Documents',
    dimWhenDisabled(
      `  ${focusMarker(focus?.kind === 'summary')}${selection.summary ? '[x]' : '[ ]'} Summary — ${summaryDetail}`,
      model.summary.state !== 'pending' && model.summary.state !== 'modified since publish',
    ),
    dimWhenDisabled(
      `  ${focusMarker(focus?.kind === 'note')}${selection.note ? '[x]' : '[ ]'} Review note — ${notePending ? 'pending' : 'none'}`,
      !notePending,
    ),
    '',
    'Review state',
    dimWhenDisabled(
      `  ${focusMarker(focus?.kind === 'checkpoint')}${selection.checkpoint ? '[x]' : '[ ]'} Checkpoint — ${
        checkpointDue ? (model.checkpoint.state === 'none' ? 'not recorded' : 'needs update') : 'current'
      }`,
      !checkpointDue,
    ),
  ];
  const footerLines = selectionFooterLines(model, selection, dimensions.columns);
  const previewHasHeading = showPreviewHeading(focus);
  const layout = selectionLayout(dimensions, footerLines.length, previewHasHeading);
  const previewLines = renderPreview(model, selection, focus, layout.previewWidth);
  const contentLines = layout.wide
    ? (() => {
        const list = visibleListLines(materialLines, layout.listHeight);
        const offset = Math.min(Math.max(0, previewOffset), Math.max(0, previewLines.length - layout.previewHeight));
        const preview = [
          ...(previewHasHeading ? ['Preview'] : []),
          ...previewLines.slice(offset, offset + layout.previewHeight),
        ];
        return Array.from({ length: layout.availableHeight }, (_, index) => {
          const listLine = list[index] ?? '';
          const previewLine = preview[index] ?? '';
          return `${fitColumn(listLine, layout.listWidth)} │ ${previewLine}`;
        });
      })()
    : (() => {
        const constrainedLines = materialLines.map((line) => truncateColumn(line, dimensions.columns));
        const list = visibleListLines(constrainedLines, layout.listHeight);
        const offset = Math.min(Math.max(0, previewOffset), Math.max(0, previewLines.length - layout.previewHeight));
        return [
          ...list,
          '',
          ...(previewHasHeading ? ['Preview'] : []),
          ...previewLines.slice(offset, offset + layout.previewHeight),
        ];
      })();

  return [...contentLines, ...footerLines].join('\n');
}

function remainingDraftMessage(model: GuidedPublishModel, selection: SelectionState): string | null {
  const findings = model.findings.length - selection.findingIndexes.size;
  const replies = model.replies.length - selection.replyIndexes.size;
  if (findings === 0 && replies === 0) return null;
  const parts: string[] = [];
  if (findings > 0) parts.push(`${findings} ${findings === 1 ? 'finding' : 'findings'}`);
  if (replies > 0) parts.push(`${replies} ${replies === 1 ? 'reply' : 'replies'}`);
  return `${parts.join(' and ')} will remain as ${findings + replies === 1 ? 'a draft' : 'drafts'}.`;
}

function renderConfirmation(model: GuidedPublishModel, selection: SelectionState): string {
  const items: string[] = [];
  if (selection.findingIndexes.size > 0) {
    items.push(`${selection.findingIndexes.size} ${selection.findingIndexes.size === 1 ? 'finding' : 'findings'}`);
  }
  if (selection.replyIndexes.size > 0) {
    items.push(`${selection.replyIndexes.size} ${selection.replyIndexes.size === 1 ? 'reply' : 'replies'}`);
  }
  if (selection.summary) items.push('Summary');
  if (selection.note) items.push('Review note');
  if (selection.checkpoint) items.push('Checkpoint');
  if (items.length === 0) items.push('Nothing');

  const remaining = remainingDraftMessage(model, selection);
  const documents = unpublishedDocuments(model, selection);
  const warning = checkpointWarning(model, selection);
  return [
    'Publish:',
    '',
    ...items.map((item) => `  ${item}`),
    ...(remaining || documents.length > 0
      ? ['', ...(remaining ? [remaining] : []), ...documents.map((document) => `${document} will remain unpublished.`)]
      : []),
    ...(warning ? ['', chalk.yellow(warning)] : []),
    '',
    'Enter publish    Esc back',
  ].join('\n');
}

function toggleGroup(model: GuidedPublishModel, selection: SelectionState, group: FocusTarget['group']): void {
  if (group === 'findings') {
    if (selection.findingIndexes.size === model.findings.length) {
      selection.findingIndexes.clear();
      selection.checkpoint = false;
    } else {
      selection.findingIndexes = new Set(model.findings.map(({ index }) => index));
    }
  } else if (group === 'replies') {
    if (selection.replyIndexes.size === model.replies.length) {
      selection.replyIndexes.clear();
      selection.checkpoint = false;
    } else {
      selection.replyIndexes = new Set(model.replies.map(({ index }) => index));
    }
  } else if (group === 'documents') {
    const summarySelectable = model.summary.state === 'pending' || model.summary.state === 'modified since publish';
    const noteSelectable = model.note.content.trim().length > 0;
    const allSelected = (!summarySelectable || selection.summary) && (!noteSelectable || selection.note);
    if (allSelected) {
      if (summarySelectable) selection.summary = false;
      if (noteSelectable) selection.note = false;
      selection.checkpoint = false;
    } else {
      if (summarySelectable) selection.summary = true;
      if (noteSelectable) selection.note = true;
    }
  } else {
    selection.checkpoint = !selection.checkpoint;
    selection.checkpointExplicit = selection.checkpoint;
  }
}

function toggleFocused(model: GuidedPublishModel, selection: SelectionState, focus: FocusTarget): void {
  if (focus.kind === 'finding-group') {
    toggleGroup(model, selection, 'findings');
  } else if (focus.kind === 'reply-group') {
    toggleGroup(model, selection, 'replies');
  } else if (focus.kind === 'finding') {
    if (selection.findingIndexes.delete(focus.index)) selection.checkpoint = false;
    else selection.findingIndexes.add(focus.index);
  } else if (focus.kind === 'reply') {
    if (selection.replyIndexes.delete(focus.index)) selection.checkpoint = false;
    else selection.replyIndexes.add(focus.index);
  } else if (focus.kind === 'summary') {
    selection.summary = !selection.summary;
    if (!selection.summary) selection.checkpoint = false;
  } else if (focus.kind === 'note') {
    selection.note = !selection.note;
    if (!selection.note) selection.checkpoint = false;
  } else if (focus.kind === 'checkpoint') {
    selection.checkpoint = !selection.checkpoint;
    selection.checkpointExplicit = selection.checkpoint;
  }
}

export async function runGuidedPublish(
  model: GuidedPublishModel,
  terminal: PublishTerminal = createNodePublishTerminal(),
): Promise<PublishSelection | null> {
  requireInteractive(terminal);
  const displayModel = sanitizeGuidedPublishModel(model);

  await terminal.start();
  try {
    const selection = initialSelection(displayModel);
    const targets = focusTargets(displayModel);
    let focusIndex = Math.max(
      0,
      targets.findIndex((target) => target.kind !== 'finding-group' && target.kind !== 'reply-group'),
    );
    let confirming = false;
    let previewOffset = 0;

    while (true) {
      const focus = targets[focusIndex];
      const dimensions = terminal.dimensions();
      previewOffset = Math.min(previewOffset, maximumPreviewOffset(displayModel, selection, focus, dimensions));
      terminal.writeFrame(
        confirming
          ? renderConfirmation(displayModel, selection)
          : renderSelection(displayModel, selection, focus, dimensions, previewOffset),
      );
      const key = await terminal.readKey();
      if (key === 'interrupt') return null;
      if (key === 'escape') {
        if (confirming) {
          confirming = false;
          continue;
        }
        return null;
      }
      if (confirming) {
        if (key === 'enter') return toPublishSelection(displayModel, selection);
        continue;
      }
      if (key === 'enter') {
        confirming = true;
      } else if (key === 'space' && focus) {
        toggleFocused(displayModel, selection, focus);
      } else if (key === 'toggle-group' && focus) {
        toggleGroup(displayModel, selection, focus.group);
      } else if (key === 'up') {
        focusIndex = Math.max(0, focusIndex - 1);
        previewOffset = 0;
      } else if (key === 'down') {
        focusIndex = Math.min(targets.length - 1, focusIndex + 1);
        previewOffset = 0;
      } else if (key === 'page-up') {
        previewOffset = Math.max(0, previewOffset - Math.max(1, Math.floor(terminal.dimensions().rows / 3)));
      } else if (key === 'page-down') {
        previewOffset = Math.min(
          maximumPreviewOffset(displayModel, selection, focus, terminal.dimensions()),
          previewOffset + Math.max(1, Math.floor(terminal.dimensions().rows / 3)),
        );
      }
    }
  } finally {
    await terminal.stop();
  }
}

export async function runStalePublishPrompt(
  terminal: PublishTerminal = createNodePublishTerminal(),
): Promise<'refresh' | 'cancel'> {
  requireInteractive(terminal);
  await terminal.start();
  try {
    let refreshFocused = true;
    while (true) {
      terminal.writeFrame(
        [
          'This review bundle is stale and its previews may no longer match the target.',
          '',
          `${refreshFocused ? '> ' : '  '}Refresh bundle`,
          `${refreshFocused ? '  ' : '> '}Cancel`,
        ].join('\n'),
      );
      const key = await terminal.readKey();
      if (key === 'escape' || key === 'interrupt') return 'cancel';
      if (key === 'up' || key === 'down') refreshFocused = !refreshFocused;
      if (key === 'enter') return refreshFocused ? 'refresh' : 'cancel';
    }
  } finally {
    await terminal.stop();
  }
}
