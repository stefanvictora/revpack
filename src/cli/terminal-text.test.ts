import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { fitColumn, truncateColumn, visibleText, wrapText, wrapTextPreservingWhitespace } from './terminal-text.js';

describe('terminal text', () => {
  it('wraps on usable word boundaries and hard-wraps complete wide graphemes', () => {
    expect(wrapText('alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
    expect(wrapText('1234567890', 10)).toEqual(['1234567890']);
    expect(wrapText('12345678901', 10)).toEqual(['1234567890', '1']);
    expect(wrapText('abc', 1)).toEqual(['a', 'b', 'c']);
    expect(wrapText('abcdef', 3)).toEqual(['abc', 'def']);
    expect(wrapText(' abc', 1)).toEqual([' ', 'a', 'b', 'c']);
    expect(wrapText('alpha   beta', 6)).toEqual(['alpha ', 'beta']);
    expect(wrapText('alpha\r\nbeta', 10)).toEqual(['alpha', 'beta']);
    expect(wrapText('審査対象確認', 10)).toEqual(['審査対象確', '認']);
    expect(wrapText('123456789👩‍💻界B', 10)).toEqual(['123456789', '👩‍💻界B']);
  });

  it('hard-wraps without consuming whitespace or splitting graphemes', () => {
    const source = '    alpha  beta';
    const wrapped = wrapTextPreservingWhitespace(source, 6);

    expect(wrapped).toEqual(['    al', 'pha  b', 'eta']);
    expect(wrapped.join('')).toBe(source);
    expect(wrapTextPreservingWhitespace(source, 6, 2)).toEqual(['    al', 'ph', 'a ', ' b', 'et', 'a']);
    expect(wrapTextPreservingWhitespace('12345👩‍💻界B', 6)).toEqual(['12345', '👩‍💻界B']);
    expect(wrapTextPreservingWhitespace('abcdef', 6)).toEqual(['abcdef']);
    expect(wrapTextPreservingWhitespace('alpha\r\nbeta', 10)).toEqual(['alpha', 'beta']);
    expect(wrapTextPreservingWhitespace('alpha\n\nbeta', 10)).toEqual(['alpha', '', 'beta']);
    expect(wrapTextPreservingWhitespace('', 10)).toEqual(['']);
    expect(wrapTextPreservingWhitespace('界', 1)).toEqual(['界']);
  });

  it('fits and truncates columns by display width', () => {
    expect(fitColumn('界', 0)).toBe('');
    expect(fitColumn('界', 4)).toBe('界  ');
    expect(fitColumn('界', 2)).toBe('界');
    expect(fitColumn('界界', 3)).toBe('界…');
    expect(fitColumn('界界界', 4)).toBe('界… ');
    expect(truncateColumn('界', 0)).toBe('');
    expect(truncateColumn('👩‍💻x', 2)).toBe('…');
    expect(truncateColumn('👩‍💻x', 3)).toBe('👩‍💻x');

    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      const styled = fitColumn(chalk.bold('界'), 4);
      expect(styled).toBe(`${chalk.bold('界')}  `);
      expect(styled).toContain('\u001b[1m');
      expect(visibleText(styled)).toBe('界  ');
    } finally {
      chalk.level = previousLevel;
    }
  });

  it('preserves ANSI styling when truncating columns', () => {
    const escape = String.fromCharCode(27);
    const bold = `${escape}[1m`;
    const unbold = `${escape}[22m`;
    const reset = `${escape}[0m`;
    const value = `${bold}focused finding${unbold}`;

    for (const truncated of [fitColumn(value, 12), truncateColumn(value, 12)]) {
      expect(visibleText(truncated)).toBe('focused fin…');
      expect(truncated).toBe(`${bold}focused fin…${reset}`);
    }

    for (const truncated of [fitColumn(value, 1), truncateColumn(value, 1)]) {
      expect(truncated).toBe(`${bold}…${reset}`);
    }

    const styledPrefix = `${bold}focus${unbold} trailing`;
    for (const truncated of [fitColumn(styledPrefix, 9), truncateColumn(styledPrefix, 9)]) {
      expect(truncated).toBe(`${bold}focus${unbold} tr…${reset}`);
    }
  });
});
