import { describe, expect, it } from 'vitest';
import type { LineMap } from './patch-parser.js';
import { extractDiffContext, formatDiffPositionLabel } from './diff-context.js';

function lineMap(overrides: Partial<LineMap['files'][number]> = {}): LineMap {
  return {
    files: [
      {
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        status: 'renamed',
        binary: false,
        oldExists: true,
        newExists: true,
        lines: [
          { type: 'context', oldLine: 7, newLine: 7, text: 'line7' },
          { type: 'context', oldLine: 8, newLine: 8, text: 'line8' },
          { type: 'context', oldLine: 9, newLine: 9, text: 'line9' },
          { type: 'removed', oldLine: 10, text: 'removedLine10' },
          { type: 'added', newLine: 10, text: 'addedLine10' },
          { type: 'context', oldLine: 11, newLine: 11, text: 'line11' },
        ],
        ...overrides,
      },
    ],
  };
}

describe('diff context', () => {
  it('shows two rows on each side of a marked point', () => {
    const context = extractDiffContext({ newPath: 'src/new.ts', newLine: 10 }, lineMap());

    expect(context?.split('\n')).toEqual([
      '       9 │ line9',
      '-     10 │ removedLine10',
      '+ ▶   10 │ addedLine10',
      '      11 │ line11',
    ]);
  });

  it('marks a new-side Code Span while retaining old-side comparison rows', () => {
    const context = extractDiffContext({ newPath: 'src/new.ts', newStartLine: 8, newLine: 11 }, lineMap());

    expect(context).toContain('┌    8 │ line8');
    expect(context).toContain('│    9 │ line9');
    expect(context).toContain('-     10 │ removedLine10');
    expect(context).toContain('+ │   10 │ addedLine10');
    expect(context).toContain('└   11 │ line11');
    expect(context?.split('\n').filter((line) => /^[ +-] [┌│└] /.test(line))).toHaveLength(4);
  });

  it('marks an old-side Code Span without selecting new-side comparison rows', () => {
    const context = extractDiffContext({ oldPath: 'src/old.ts', oldStartLine: 8, oldLine: 11 }, lineMap());

    expect(context).toContain('┌    8 │ line8');
    expect(context).toContain('│    9 │ line9');
    expect(context).toContain('- │   10 │ removedLine10');
    expect(context).toContain('+     10 │ addedLine10');
    expect(context).toContain('└   11 │ line11');
  });

  it('matches removed anchors through the old path and old line', () => {
    const context = extractDiffContext({ oldPath: 'src/old.ts', oldLine: 10 }, lineMap());

    expect(context).toContain('- ▶   10 │ removedLine10');
    expect(context).toContain('+     10 │ addedLine10');
    expect(context).not.toContain('+ ▶   10 │ addedLine10');
  });

  it('matches a context line when only one side of its position is available', () => {
    expect(extractDiffContext({ oldPath: 'src/old.ts', oldLine: 11 }, lineMap())).toContain('▶   11 │ line11');
    expect(extractDiffContext({ newPath: 'src/new.ts', newLine: 11 }, lineMap())).toContain('▶   11 │ line11');
  });

  it('requires both sides to match when both endpoint positions are provided', () => {
    expect(extractDiffContext({ newPath: 'src/new.ts', oldLine: 10, newLine: 10 }, lineMap())).toBeNull();
    expect(extractDiffContext({ newPath: 'src/new.ts', oldLine: 11, newLine: 11 }, lineMap())).toContain(
      '▶   11 │ line11',
    );
  });

  it('condenses Code Spans longer than twelve selected lines', () => {
    const lines = Array.from({ length: 16 }, (_, index) => ({
      type: 'context' as const,
      oldLine: index + 1,
      newLine: index + 1,
      text: `source-${index + 1}`,
      hunkIndex: 0,
    }));
    const context = extractDiffContext({ newPath: 'src/new.ts', newStartLine: 1, newLine: 16 }, lineMap({ lines }));

    expect(context).toContain('┌    1 │ source-1');
    expect(context).toContain('│    5 │ source-5');
    expect(context).toContain('6 selected lines omitted');
    expect(context).not.toContain('source-6');
    expect(context).not.toContain('source-11');
    expect(context).toContain('│   12 │ source-12');
    expect(context).toContain('└   16 │ source-16');
    expect(context?.split('\n')).toHaveLength(11);
  });

  it('shows twelve selected lines completely and condenses thirteen', () => {
    const lines = Array.from({ length: 13 }, (_, index) => ({
      type: 'context' as const,
      oldLine: index + 1,
      newLine: index + 1,
      text: `threshold-${index + 1}`,
      hunkIndex: 0,
    }));

    const complete = extractDiffContext({ newPath: 'src/new.ts', newStartLine: 1, newLine: 12 }, lineMap({ lines }));
    const condensed = extractDiffContext({ newPath: 'src/new.ts', newStartLine: 1, newLine: 13 }, lineMap({ lines }));

    expect(complete).toContain('threshold-6');
    expect(complete).not.toContain('selected lines omitted');
    expect(condensed).toContain('3 selected lines omitted');
    expect(condensed).toContain('threshold-5');
    expect(condensed).not.toContain('threshold-6');
    expect(condensed).not.toContain('threshold-8');
    expect(condensed).toContain('threshold-9');
  });

  it('does not take context from an adjacent hunk', () => {
    const context = extractDiffContext(
      { newPath: 'src/new.ts', newLine: 2 },
      lineMap({
        lines: [
          { type: 'context', oldLine: 1, newLine: 1, text: 'first-hunk-context', hunkIndex: 0 },
          { type: 'added', newLine: 2, text: 'first-hunk-target', hunkIndex: 0 },
          { type: 'context', oldLine: 20, newLine: 20, text: 'second-hunk-context', hunkIndex: 1 },
        ],
      }),
    );

    expect(context).toContain('first-hunk-context');
    expect(context).toContain('first-hunk-target');
    expect(context).not.toContain('second-hunk-context');
  });

  it('falls back to the endpoint when the Code Span start is unavailable in the hunk', () => {
    const context = extractDiffContext({ newPath: 'src/new.ts', newStartLine: 1, newLine: 10 }, lineMap());

    expect(context).toContain('+ ▶   10 │ addedLine10');
    expect(context).not.toMatch(/[┌└]/);
  });

  it('returns no context without a matching file or positional line', () => {
    expect(extractDiffContext({ newPath: 'src/missing.ts', newLine: 10 }, lineMap())).toBeNull();
    expect(extractDiffContext({ newPath: 'src/new.ts' }, lineMap())).toBeNull();
    expect(extractDiffContext({ newPath: 'src/new.ts', newLine: 10 }, lineMap({ lines: [] }))).toBeNull();
  });
});

describe('diff position labels', () => {
  it('formats points and Code Spans with provider-neutral side names', () => {
    expect(formatDiffPositionLabel({ newLine: 10 })).toBe('new line 10');
    expect(formatDiffPositionLabel({ newStartLine: 10, newLine: 10 })).toBe('new line 10');
    expect(formatDiffPositionLabel({ oldStartLine: 5, oldLine: 8 })).toBe('old lines 5–8');
    expect(formatDiffPositionLabel({ oldLine: 7, newLine: 9 })).toBe('old line 7, new line 9');
  });

  it('treats invalid starts as point labels', () => {
    expect(formatDiffPositionLabel({ newStartLine: 12, newLine: 10 })).toBe('new line 10');
    expect(formatDiffPositionLabel({})).toBeNull();
  });
});
