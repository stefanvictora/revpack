import type { LineMap } from './patch-parser.js';

export interface DiffContextPosition {
  filePath?: string;
  oldPath?: string;
  newPath?: string;
  oldLine?: number;
  newLine?: number;
}

/**
 * Format a compact diff excerpt around a positional anchor.
 * Shows up to three lines before the anchor and one line after it.
 */
export function extractDiffContext(position: DiffContextPosition, lineMap: LineMap): string | null {
  const candidatePaths = new Set([position.newPath, position.oldPath, position.filePath]);
  const file = lineMap.files.find(
    (candidate) => candidatePaths.has(candidate.newPath) || candidatePaths.has(candidate.oldPath),
  );
  if (!file) return null;
  if (position.newLine === undefined && position.oldLine === undefined) return null;

  const lineIndex = file.lines.findIndex(
    (line) =>
      (position.newLine === undefined || line.newLine === position.newLine) &&
      (position.oldLine === undefined || line.oldLine === position.oldLine),
  );
  if (lineIndex === -1) return null;

  const start = Math.max(0, lineIndex - 3);
  const end = lineIndex + 1;
  return file.lines
    .slice(start, end + 1)
    .map((line, offset) => {
      const prefix = line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' ';
      const lineNumber = line.newLine ?? line.oldLine ?? '';
      const marker = start + offset === lineIndex ? ' ◀' : '';
      return `${prefix} ${String(lineNumber).padStart(4)} | ${line.text}${marker}`;
    })
    .join('\n');
}
