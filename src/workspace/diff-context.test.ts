import { describe, expect, it } from 'vitest';
import type { LineMap } from './patch-parser.js';
import { extractDiffContext } from './diff-context.js';

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
  it('shows three lines above, the marked anchor, and one line below', () => {
    const context = extractDiffContext({ newPath: 'src/new.ts', newLine: 10 }, lineMap());

    expect(context?.split('\n')).toEqual([
      '     8 | line8',
      '     9 | line9',
      '-   10 | removedLine10',
      '+   10 | addedLine10 ◀',
      '    11 | line11',
    ]);
  });

  it('matches removed anchors through the old path and old line', () => {
    const context = extractDiffContext({ oldPath: 'src/old.ts', oldLine: 10 }, lineMap());

    expect(context).toContain('-   10 | removedLine10 ◀');
    expect(context).not.toContain('addedLine10 ◀');
    expect(context).not.toContain('line11');
  });

  it('matches a context line when only one side of its position is available', () => {
    expect(extractDiffContext({ oldPath: 'src/old.ts', oldLine: 11 }, lineMap())).toContain('    11 | line11 ◀');
    expect(extractDiffContext({ newPath: 'src/new.ts', newLine: 11 }, lineMap())).toContain('    11 | line11 ◀');
  });

  it('requires both sides to match for a context anchor', () => {
    expect(extractDiffContext({ newPath: 'src/new.ts', oldLine: 10, newLine: 10 }, lineMap())).toBeNull();
    expect(extractDiffContext({ newPath: 'src/new.ts', oldLine: 11, newLine: 11 }, lineMap())).toContain(
      '    11 | line11 ◀',
    );
  });

  it('returns no context without a matching file or positional line', () => {
    expect(extractDiffContext({ newPath: 'src/missing.ts', newLine: 10 }, lineMap())).toBeNull();
    expect(extractDiffContext({ newPath: 'src/new.ts' }, lineMap())).toBeNull();
    expect(
      extractDiffContext(
        { newPath: 'src/new.ts', newLine: 10 },
        lineMap({
          lines: [],
        }),
      ),
    ).toBeNull();
  });
});
