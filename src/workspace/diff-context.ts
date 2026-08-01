import type { LineEntry, LineMap } from './patch-parser.js';

export interface DiffContextPosition {
  filePath?: string;
  oldPath?: string;
  newPath?: string;
  oldStartLine?: number;
  newStartLine?: number;
  oldLine?: number;
  newLine?: number;
}

const CONTEXT_ROWS = 2;
const COMPLETE_SPAN_LINE_LIMIT = 12;
const CONDENSED_SPAN_EDGE_LINES = 5;

type DiffSide = 'old' | 'new';

interface SelectedSpan {
  indexes: number[];
  side: DiffSide;
}

interface PreviewRow {
  line?: LineEntry;
  index?: number;
  omittedSelectedLines?: number;
}

function sideLine(line: LineEntry, side: DiffSide): number | undefined {
  return side === 'new' ? line.newLine : line.oldLine;
}

function sameHunk(left: LineEntry, right: LineEntry): boolean {
  return left.hunkIndex === right.hunkIndex;
}

function resolveSelectedSpan(
  position: DiffContextPosition,
  lines: readonly LineEntry[],
  anchorIndex: number,
  hunkStart: number,
  hunkEnd: number,
): SelectedSpan | null {
  const candidates: Array<{ side: DiffSide; startLine: number | undefined; endLine: number | undefined }> = [
    { side: 'new', startLine: position.newStartLine, endLine: position.newLine },
    { side: 'old', startLine: position.oldStartLine, endLine: position.oldLine },
  ];
  const range = candidates.find(
    (candidate) =>
      candidate.startLine !== undefined && candidate.endLine !== undefined && candidate.startLine < candidate.endLine,
  );

  if (range?.startLine !== undefined && range.endLine !== undefined) {
    const startIndex = lines.findIndex(
      (line, index) => index >= hunkStart && index <= anchorIndex && sideLine(line, range.side) === range.startLine,
    );
    if (startIndex !== -1) {
      const indexes: number[] = [];
      for (let index = startIndex; index <= hunkEnd; index++) {
        const lineNumber = sideLine(lines[index], range.side);
        if (lineNumber !== undefined && lineNumber >= range.startLine && lineNumber <= range.endLine) {
          indexes.push(index);
        }
      }
      if (indexes.at(-1) === anchorIndex) {
        return { indexes, side: range.side };
      }
    }
  }

  const pointSide: DiffSide = position.newLine !== undefined ? 'new' : 'old';
  const pointLine = pointSide === 'new' ? position.newLine : position.oldLine;
  if (pointLine === undefined) return null;
  return { indexes: [anchorIndex], side: pointSide };
}

function previewRows(
  lines: readonly LineEntry[],
  span: SelectedSpan,
  hunkStart: number,
  hunkEnd: number,
): PreviewRow[] {
  const firstSelected = span.indexes[0];
  const lastSelected = span.indexes.at(-1)!;
  const windowStart = Math.max(hunkStart, firstSelected - CONTEXT_ROWS);
  const windowEnd = Math.min(hunkEnd, lastSelected + CONTEXT_ROWS);

  if (span.indexes.length <= COMPLETE_SPAN_LINE_LIMIT) {
    return lines.slice(windowStart, windowEnd + 1).map((line, offset) => ({ line, index: windowStart + offset }));
  }

  const leadingEnd = span.indexes[CONDENSED_SPAN_EDGE_LINES - 1];
  const trailingStart = span.indexes.at(-CONDENSED_SPAN_EDGE_LINES)!;
  return [
    ...lines.slice(windowStart, leadingEnd + 1).map((line, offset) => ({ line, index: windowStart + offset })),
    { omittedSelectedLines: span.indexes.length - CONDENSED_SPAN_EDGE_LINES * 2 },
    ...lines.slice(trailingStart, windowEnd + 1).map((line, offset) => ({ line, index: trailingStart + offset })),
  ];
}

function sideLabel(side: DiffSide, startLine: number | undefined, endLine: number | undefined): string | null {
  if (endLine === undefined) return null;
  return startLine !== undefined && startLine < endLine
    ? `${side} lines ${startLine}–${endLine}`
    : `${side} line ${endLine}`;
}

export function formatDiffPositionLabel(position: DiffContextPosition): string | null {
  const labels = [
    sideLabel('old', position.oldStartLine, position.oldLine),
    sideLabel('new', position.newStartLine, position.newLine),
  ].filter((label): label is string => label !== null);
  return labels.length > 0 ? labels.join(', ') : null;
}

/**
 * Format a compact diff excerpt around a positional anchor or Code Span.
 * Shows two rows of context on each side without crossing hunk boundaries.
 */
export function extractDiffContext(position: DiffContextPosition, lineMap: LineMap): string | null {
  const candidatePaths = new Set([position.newPath, position.oldPath, position.filePath]);
  const file = lineMap.files.find(
    (candidate) => candidatePaths.has(candidate.newPath) || candidatePaths.has(candidate.oldPath),
  );
  if (!file) return null;
  if (position.newLine === undefined && position.oldLine === undefined) return null;

  const anchorIndex = file.lines.findIndex(
    (line) =>
      (position.newLine === undefined || line.newLine === position.newLine) &&
      (position.oldLine === undefined || line.oldLine === position.oldLine),
  );
  if (anchorIndex === -1) return null;

  const anchor = file.lines[anchorIndex];
  let hunkStart = anchorIndex;
  let hunkEnd = anchorIndex;
  while (hunkStart > 0 && sameHunk(file.lines[hunkStart - 1], anchor)) hunkStart--;
  while (hunkEnd + 1 < file.lines.length && sameHunk(file.lines[hunkEnd + 1], anchor)) hunkEnd++;

  const span = resolveSelectedSpan(position, file.lines, anchorIndex, hunkStart, hunkEnd);
  if (!span) return null;
  const selectedIndexes = new Set(span.indexes);
  const rows = previewRows(file.lines, span, hunkStart, hunkEnd);
  const oppositeSide: DiffSide = span.side === 'new' ? 'old' : 'new';
  const displayLineNumber = (line: LineEntry): number | undefined =>
    sideLine(line, span.side) ?? sideLine(line, oppositeSide);
  const lineNumberWidth = Math.max(
    4,
    ...rows.flatMap((row) => (row.line ? [String(displayLineNumber(row.line) ?? '').length] : [])),
  );

  return rows
    .map((row) => {
      if (!row.line || row.index === undefined) {
        return `  … ${''.padStart(lineNumberWidth)} │ ${row.omittedSelectedLines} selected lines omitted`;
      }
      const prefix = row.line.type === 'added' ? '+' : row.line.type === 'removed' ? '-' : ' ';
      const selectedOffset = span.indexes.indexOf(row.index);
      const marker = !selectedIndexes.has(row.index)
        ? ' '
        : span.indexes.length === 1
          ? '▶'
          : selectedOffset === 0
            ? '┌'
            : selectedOffset === span.indexes.length - 1
              ? '└'
              : '│';
      const lineNumber = displayLineNumber(row.line) ?? '';
      return `${prefix} ${marker} ${String(lineNumber).padStart(lineNumberWidth)} │ ${row.line.text}`;
    })
    .join('\n');
}
