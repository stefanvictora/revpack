// Patch parser: generates a structured line map from unified diff (patch) content.

export type LineType = 'context' | 'added' | 'removed';
export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'unknown';

export interface LineEntry {
  type: LineType;
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface FileEntry {
  oldPath: string;
  newPath: string;
  status: FileStatus;
  lines: LineEntry[];
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
  while (i < lines.length) {
    // Look for "diff --git" header
    if (!lines[i].startsWith('diff --git ')) {
      i++;
      continue;
    }

    const header = parseDiffHeader(lines, i);
    i = header.nextIndex;

    const fileEntry: FileEntry = {
      oldPath: header.parsed.oldPath,
      newPath: header.parsed.newPath,
      status: inferStatus(header.parsed),
      lines: [],
    };

    // Parse hunks
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      if (lines[i].startsWith('@@ ')) {
        const hunkResult = parseHunk(lines, i);
        fileEntry.lines.push(...hunkResult.entries);
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
  const gitMatch = diffLine.match(/^diff --git a\/(.+?) b\/(.+)$/);

  let oldPath = gitMatch?.[1] ?? '';
  let newPath = gitMatch?.[2] ?? '';
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
      const path = line.slice(4);
      if (path === '/dev/null') {
        isNew = true;
      } else if (path.startsWith('a/')) {
        oldPath = path.slice(2);
      }
      i++;
      continue;
    }

    if (line.startsWith('+++ ')) {
      const path = line.slice(4);
      if (path === '/dev/null') {
        isDeleted = true;
      } else if (path.startsWith('b/')) {
        newPath = path.slice(2);
      }
      i++;
      continue;
    }

    if (line.startsWith('rename from ')) {
      renameFrom = line.slice('rename from '.length);
      isRenamed = true;
      i++;
      continue;
    }

    if (line.startsWith('rename to ')) {
      renameTo = line.slice('rename to '.length);
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

function inferStatus(header: PatchFileHeader): FileStatus {
  if (header.isNew) return 'added';
  if (header.isDeleted) return 'deleted';
  if (header.isRenamed) return 'renamed';
  if (header.isCopy) return 'copied';
  if (header.oldPath && header.newPath) return 'modified';
  return 'unknown';
}

function parseHunk(lines: string[], startIndex: number): { entries: LineEntry[]; nextIndex: number } {
  const entries: LineEntry[] = [];
  const hunkHeader = lines[startIndex];

  // Parse @@ -oldStart,oldCount +newStart,newCount @@
  const hunkMatch = hunkHeader.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
  if (!hunkMatch) {
    return { entries, nextIndex: startIndex + 1 };
  }

  let oldLine = parseInt(hunkMatch[1], 10);
  let newLine = parseInt(hunkMatch[2], 10);

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

    // Context line (starts with space) or empty context line
    if (line.startsWith(' ') || line === '') {
      entries.push({
        type: 'context',
        oldLine,
        newLine,
        text: line.startsWith(' ') ? line.slice(1) : line,
      });
      oldLine++;
      newLine++;
      i++;
      continue;
    }

    // Unknown line — skip
    i++;
  }

  return { entries, nextIndex: i };
}
