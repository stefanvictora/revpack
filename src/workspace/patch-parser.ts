// Patch parser: generates a structured line map from unified diff (patch) content.

export type LineType = 'context' | 'added' | 'removed';
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unknown';

export interface LineEntry {
  type: LineType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface HunkInfo {
  hunkId: string;
  oldStart: number;
  oldEnd: number;
  newStart: number;
  newEnd: number;
  header: string;
  lines: LineEntry[];
}

export interface FileEntry {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  lines: LineEntry[];
  hunks: HunkInfo[];
}

export interface LineMap {
  files: FileEntry[];
}

interface PatchFileHeader {
  oldPath: string;
  newPath: string;
  renameFrom?: string;
  renameTo?: string;
  isNew: boolean;
  isDeleted: boolean;
  isRenamed: boolean;
  isCopy: boolean;
}

/**
 * Parse a unified diff (patch) string into a structured LineMap.
 */
export function parsePatch(patch: string): LineMap {
  const lines = patch.split('\n');
  const files: FileEntry[] = [];

  let i = 0;
  let fileIndex = 0;
  while (i < lines.length) {
    // Look for "diff --git" header
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const header = parseDiffHeader(lines, i);
    i = header.nextIndex;
    fileIndex++;

    const fileId = `F${String(fileIndex).padStart(3, '0')}`;
    const fileEntry: FileEntry = {
      oldPath: header.parsed.oldPath,
      newPath: header.parsed.newPath,
      status: inferStatus(header.parsed),
      lines: [],
      hunks: [],
    };

    // Parse hunks
    let hunkIndex = 0;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@ ')) {
        hunkIndex++;
        const hunkId = `${fileId}-H${String(hunkIndex).padStart(3, '0')}`;
        const hunkResult = parseHunk(lines, i, hunkId);
        fileEntry.lines.push(...hunkResult.entries);
        fileEntry.hunks.push(hunkResult.hunkInfo);
        i = hunkResult.nextIndex;
      } else {
        i++;
      }
    }

    files.push(fileEntry);
  }

  return { files };
}

function parseDiffHeader(lines: string[], startIndex: number): { parsed: PatchFileHeader; nextIndex: number } {
  // Parse "diff --git a/path b/path"
  const diffLine = lines[startIndex];
  const gitPaths = parseDiffGitPaths(diffLine);

  let oldPath = stripGitPrefix(gitPaths?.oldPath ?? '', 'a/');
  let newPath = stripGitPrefix(gitPaths?.newPath ?? '', 'b/');
  let renameFrom: string | undefined;
  let renameTo: string | undefined;
  let isNew = false;
  let isDeleted = false;
  let isRenamed = false;
  let isCopy = false;

  let i = startIndex + 1;

  // Scan metadata lines until we hit a hunk or next diff
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) {
      break;
    }

    if (line.startsWith('--- ')) {
      const path = parseGitPathToken(line.slice(4));
      if (path === '/dev/null') {
        isNew = true;
      } else {
        oldPath = stripGitPrefix(path, 'a/');
      }
      i++;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = parseGitPathToken(line.slice(4));
      if (path === '/dev/null') {
        isDeleted = true;
      } else {
        newPath = stripGitPrefix(path, 'b/');
      }
      i++;
      continue;
    }

    if (line.startsWith('rename from ')) {
      renameFrom = parseGitPathToken(line.slice('rename from '.length));
      isRenamed = true;
      i++;
      continue;
    }

    if (line.startsWith('rename to ')) {
      renameTo = parseGitPathToken(line.slice('rename to '.length));
      isRenamed = true;
      i++;
      continue;
    }

    if (line.startsWith('copy from ')) {
      isCopy = true;
      i++;
      continue;
    }

    if (line.startsWith('copy to ')) {
      isCopy = true;
      i++;
      continue;
    }

    // Skip other metadata: index, similarity index, old mode, new mode, etc.
    i++;
  }

  // Prefer rename metadata for paths
  if (isRenamed && renameFrom) oldPath = renameFrom;
  if (isRenamed && renameTo) newPath = renameTo;

  // For added files, GitLab expects both old_path and new_path to be the new file path
  if (isNew) {
    oldPath = newPath;
  }
  // For deleted files, GitLab expects both to be the old file path
  if (isDeleted) {
    newPath = oldPath;
  }

  return {
    parsed: { oldPath, newPath, renameFrom, renameTo, isNew, isDeleted, isRenamed, isCopy },
    nextIndex: i,
  };
}

function parseDiffGitPaths(line: string): { oldPath: string; newPath: string } | null {
  const prefix = 'diff --git ';
  if (!line.startsWith(prefix)) return null;

  const tokens = parseGitPathTokens(line.slice(prefix.length));
  if (tokens.length < 2) return null;
  return { oldPath: tokens[0], newPath: tokens[1] };
}

function parseGitPathToken(input: string): string {
  return parseGitPathTokens(input.trim())[0] ?? input.trim();
}

function parseGitPathTokens(input: string): string[] {
  const tokens: string[] = [];
  let i = 0;

  while (i < input.length) {
    while (input[i] === ' ' || input[i] === '\t') i++;
    if (i >= input.length) break;

    if (input[i] === '"') {
      const parsed = parseQuotedGitPath(input, i);
      tokens.push(parsed.value);
      i = parsed.nextIndex;
      continue;
    }

    const start = i;
    while (i < input.length && input[i] !== ' ' && input[i] !== '\t') i++;
    tokens.push(input.slice(start, i));
  }

  return tokens;
}

function parseQuotedGitPath(input: string, quoteIndex: number): { value: string; nextIndex: number } {
  let value = '';
  let i = quoteIndex + 1;

  while (i < input.length) {
    const char = input[i];
    if (char === '"') {
      return { value, nextIndex: i + 1 };
    }
    if (char === '\\' && i + 1 < input.length) {
      const parsed = parseGitEscape(input, i + 1);
      value += parsed.value;
      i = parsed.nextIndex;
      continue;
    }
    value += char;
    i++;
  }

  return { value, nextIndex: i };
}

function parseGitEscape(input: string, escapeIndex: number): { value: string; nextIndex: number } {
  const char = input[escapeIndex];
  switch (char) {
    case 'a':
      return { value: '\x07', nextIndex: escapeIndex + 1 };
    case 'b':
      return { value: '\b', nextIndex: escapeIndex + 1 };
    case 'f':
      return { value: '\f', nextIndex: escapeIndex + 1 };
    case 'n':
      return { value: '\n', nextIndex: escapeIndex + 1 };
    case 'r':
      return { value: '\r', nextIndex: escapeIndex + 1 };
    case 't':
      return { value: '\t', nextIndex: escapeIndex + 1 };
    case 'v':
      return { value: '\v', nextIndex: escapeIndex + 1 };
    case '\\':
    case '"':
      return { value: char, nextIndex: escapeIndex + 1 };
    default:
      if (/[0-7]/.test(char)) {
        let octal = char;
        let i = escapeIndex + 1;
        while (i < input.length && octal.length < 3 && /[0-7]/.test(input[i])) {
          octal += input[i];
          i++;
        }
        return { value: String.fromCharCode(parseInt(octal, 8)), nextIndex: i };
      }
      return { value: char, nextIndex: escapeIndex + 1 };
  }
}

function stripGitPrefix(path: string, prefix: 'a/' | 'b/'): string {
  return path.startsWith(prefix) ? path.slice(2) : path;
}

function inferStatus(header: PatchFileHeader): FileStatus {
  if (header.isNew) return 'added';
  if (header.isDeleted) return 'deleted';
  if (header.isRenamed) return 'renamed';
  if (header.isCopy) return 'copied';
  if (header.oldPath && header.newPath) return 'modified';
  return 'unknown';
}

function parseHunk(
  lines: string[],
  startIndex: number,
  hunkId: string,
): { entries: LineEntry[]; hunkInfo: HunkInfo; nextIndex: number } {
  const entries: LineEntry[] = [];
  const hunkHeader = lines[startIndex];

  // Parse @@ -oldStart,oldCount +newStart,newCount @@
  const hunkMatch = hunkHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
  if (!hunkMatch) {
    return {
      entries,
      hunkInfo: { hunkId, oldStart: 0, oldEnd: 0, newStart: 0, newEnd: 0, header: '', lines: [] },
      nextIndex: startIndex + 1,
    };
  }

  const hunkContext = hunkMatch[3]?.trim() ?? '';
  let oldLine = parseInt(hunkMatch[1], 10);
  let newLine = parseInt(hunkMatch[2], 10);
  const oldStart = oldLine;
  const newStart = newLine;

  let i = startIndex + 1;

  while (i < lines.length) {
    const line = lines[i];

    // Stop at next hunk or next diff
    if (line.startsWith('diff --git ') || line.startsWith('@@ ')) {
      break;
    }

    // "\ No newline at end of file" — ignore for position mapping
    if (line.startsWith('\\ ')) {
      i++;
      continue;
    }

    if (line.startsWith('+')) {
      entries.push({
        type: 'added',
        newLine,
        text: line.slice(1),
      });
      newLine++;
      i++;
      continue;
    }

    if (line.startsWith('-')) {
      entries.push({
        type: 'removed',
        oldLine,
        text: line.slice(1),
      });
      oldLine++;
      i++;
      continue;
    }

    // Context lines in unified diffs always start with a space. A bare empty
    // string is usually the split artifact from a trailing newline or a
    // separator between file patches, not an actual hunk line.
    if (line.startsWith(' ')) {
      entries.push({
        type: 'context',
        oldLine,
        newLine,
        text: line.slice(1),
      });
      oldLine++;
      newLine++;
      i++;
      continue;
    }

    // Unknown line — skip
    i++;
  }

  const hunkInfo: HunkInfo = {
    hunkId,
    oldStart,
    oldEnd: oldLine - 1,
    newStart,
    newEnd: newLine - 1,
    header: hunkContext,
    lines: entries,
  };

  return { entries, hunkInfo, nextIndex: i };
}
