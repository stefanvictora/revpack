import { describe, expect, it } from 'vitest';
import { fitColumn, truncateColumn, wrapText } from './terminal-text.js';

describe('terminal text', () => {
  it('wraps on usable word boundaries and hard-wraps complete wide graphemes', () => {
    expect(wrapText('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
    expect(wrapText('1234567890', 10)).toEqual(['1234567890']);
    expect(wrapText('12345678901', 10)).toEqual(['1234567890', '1']);
    expect(wrapText('審査対象確認', 10)).toEqual(['審査対象確', '認']);
    expect(wrapText('123456789👩‍💻界B', 10)).toEqual(['123456789', '👩‍💻界B']);
  });

  it('fits and truncates columns by display width', () => {
    expect(fitColumn('界', 0)).toBe('');
    expect(fitColumn('界', 4)).toBe('界  ');
    expect(fitColumn('界', 2)).toBe('界');
    expect(fitColumn('界界', 3)).toBe('界…');
    expect(truncateColumn('界', 0)).toBe('');
    expect(truncateColumn('👩‍💻x', 2)).toBe('…');
    expect(truncateColumn('👩‍💻x', 3)).toBe('👩‍💻x');
  });
});
