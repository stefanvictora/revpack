import { describe, expect, it } from 'vitest';
import { stripVTControlCharacters } from 'node:util';
import chalk from 'chalk';
import stringWidth from 'string-width';
import { renderMarkdownPreview } from './publish-tui-markdown.js';

describe('publish TUI Markdown', () => {
  it('renders the supported Markdown subset without source markers', () => {
    const rendered = renderMarkdownPreview(
      [
        '# Review heading',
        '',
        '- **Important** change with `inline code`',
        '**Malformed-queue gating applies to `publish all` too.**',
        '1. Read the [provider docs](https://example.com/docs)',
        '> Confirm _existing behavior_.',
        '```ts',
        'const enabled = true;',
        '```',
      ].join('\n'),
      80,
    ).map(stripVTControlCharacters);

    expect(rendered).toEqual([
      'Review heading',
      '',
      '• Important change with inline code',
      'Malformed-queue gating applies to publish all too.',
      '1. Read the provider docs (https://example.com/docs)',
      '│ Confirm existing behavior.',
      '[ts]',
      '│ const enabled = true;',
    ]);
  });

  it('uses restrained Chalk styles for supported Markdown', () => {
    const previousLevel = chalk.level;
    chalk.level = 1;
    try {
      const rendered = renderMarkdownPreview(
        [
          '# Heading',
          '> quoted',
          '**strong** _emphasis_ `code` [docs](https://example.com)',
          '**strong with `nested code`** and _emphasis with `nested code`_',
          '```ts',
          'const value = true;',
          '```',
        ].join('\n'),
        80,
      );

      expect(rendered).toEqual([
        chalk.cyan.bold('Heading'),
        chalk.dim('│ ') + chalk.dim('quoted'),
        [
          chalk.bold('strong'),
          ' ',
          chalk.italic('emphasis'),
          ' ',
          chalk.cyan('code'),
          ' ',
          chalk.underline('docs'),
          ' (',
          chalk.dim('https://example.com'),
          ')',
        ].join(''),
        [
          chalk.bold('strong with '),
          chalk.bold.cyan('nested code'),
          ' and ',
          chalk.italic('emphasis with '),
          chalk.italic.cyan('nested code'),
        ].join(''),
        chalk.dim('[ts]'),
        chalk.dim('│ ') + chalk.gray('const value = true;'),
      ]);
    } finally {
      chalk.level = previousLevel;
    }
  });

  it.each([
    ['closing heading markers', '### Heading ###', ['Heading']],
    ['unordered marker variants', '+ plus\n* star', ['• plus', '• star']],
    ['ordered marker variants', '12) twelve\n2. two', ['12. twelve', '2. two']],
    ['tilde code fence', '~~~sh\necho ready\n~~~', ['[sh]', '│ echo ready']],
    ['empty quote', '>', ['│']],
    ['double-underscore bold and asterisk italic', '__bold__ and *italic*', ['bold and italic']],
  ])('renders %s', (_label, source, expected) => {
    expect(renderMarkdownPreview(source, 80).map(stripVTControlCharacters)).toEqual(expected);
  });

  it('keeps malformed, nested, and unsupported Markdown literal', () => {
    const rendered = renderMarkdownPreview(
      [
        '| Column | Value |',
        '| --- | --- |',
        '**bold with _nested italics_**',
        '**bold with `unclosed code**',
        '`unclosed code',
        '** spaced **',
        '_ spaced _',
        'snake_case_name',
        '\\*escaped emphasis*',
        '```ts',
        'const unclosed = true;',
      ].join('\n'),
      80,
    ).map(stripVTControlCharacters);

    expect(rendered).toEqual([
      '| Column | Value |',
      '| --- | --- |',
      '**bold with _nested italics_**',
      '**bold with `unclosed code**',
      '`unclosed code',
      '** spaced **',
      '_ spaced _',
      'snake_case_name',
      '\\*escaped emphasis*',
      '```ts',
      'const unclosed = true;',
    ]);
  });

  it('shows a link destination once when its label is already the URL', () => {
    expect(
      renderMarkdownPreview('[https://example.com](https://example.com)', 80).map(stripVTControlCharacters),
    ).toEqual(['https://example.com']);
  });

  it('wraps list items and fenced code without exceeding the preview width', () => {
    const rendered = renderMarkdownPreview(
      ['- alpha beta gamma delta', '```ts', 'const deliberatelyLongName = value;', '```'].join('\n'),
      14,
    );

    expect(rendered.map(stripVTControlCharacters)).toEqual([
      '• alpha beta',
      '  gamma delta',
      '[ts]',
      '│ const',
      '│ deliberately',
      '│ LongName =',
      '│ value;',
    ]);
    for (const line of rendered) {
      expect(stringWidth(stripVTControlCharacters(line))).toBeLessThanOrEqual(14);
    }
  });
});
