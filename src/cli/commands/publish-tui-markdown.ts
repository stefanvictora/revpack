import chalk from 'chalk';
import stringWidth from 'string-width';
import { visibleText, wrapText } from '../terminal-text.js';

type MarkdownInlineStyle =
  'plain' | 'bold' | 'italic' | 'code' | 'bold-code' | 'italic-code' | 'link-label' | 'link-url';
type MarkdownBlockStyle = 'plain' | 'heading' | 'quote' | 'code';

interface MarkdownSpan {
  text: string;
  style: MarkdownInlineStyle;
}

interface MarkdownUnit extends MarkdownSpan {
  width: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter();

function appendMarkdownSpan(spans: MarkdownSpan[], text: string, style: MarkdownInlineStyle): void {
  if (!text) return;
  const previous = spans.at(-1);
  if (previous?.style === style) {
    previous.text += text;
  } else {
    spans.push({ text, style });
  }
}

function containsUnsupportedEmphasisSyntax(value: string): boolean {
  return [...value].some((character) => ['*', '_', '[', ']'].includes(character));
}

function emphasisMarkdownSpans(content: string, style: 'bold' | 'italic'): MarkdownSpan[] | null {
  if (content === '' || content.trim() !== content) {
    return null;
  }

  const spans: MarkdownSpan[] = [];
  let offset = 0;
  while (offset < content.length) {
    const opening = content.indexOf('`', offset);
    if (opening < 0) {
      const remaining = content.slice(offset);
      if (containsUnsupportedEmphasisSyntax(remaining)) return null;
      appendMarkdownSpan(spans, remaining, style);
      break;
    }

    const closing = content.indexOf('`', opening + 1);
    if (closing <= opening + 1) return null;
    const beforeCode = content.slice(offset, opening);
    if (containsUnsupportedEmphasisSyntax(beforeCode)) return null;
    appendMarkdownSpan(spans, beforeCode, style);
    appendMarkdownSpan(spans, content.slice(opening + 1, closing), style === 'bold' ? 'bold-code' : 'italic-code');
    offset = closing + 1;
  }
  return spans;
}

function inlineMarkdownMatch(value: string, start: number): { length: number; spans: MarkdownSpan[] } | null {
  const remaining = value.slice(start);
  if (remaining.startsWith('`')) {
    const closing = remaining.indexOf('`', 1);
    if (closing > 1) {
      return {
        length: closing + 1,
        spans: [{ text: remaining.slice(1, closing), style: 'code' }],
      };
    }
    return {
      length: remaining.length,
      spans: [{ text: remaining, style: 'plain' }],
    };
  }

  if (remaining.startsWith('[')) {
    const link = remaining.match(/^\[([^\]\n]+)]\(([^)\n]+)\)/);
    if (link) {
      const [, label, destination] = link;
      return {
        length: link[0].length,
        spans:
          label === destination
            ? [{ text: destination, style: 'link-label' }]
            : [
                { text: label, style: 'link-label' },
                { text: ' (', style: 'plain' },
                { text: destination, style: 'link-url' },
                { text: ')', style: 'plain' },
              ],
      };
    }
  }

  for (const marker of ['**', '__'] as const) {
    if (!remaining.startsWith(marker)) continue;
    const closing = remaining.indexOf(marker, marker.length);
    const content = closing < 0 ? '' : remaining.slice(marker.length, closing);
    const spans = emphasisMarkdownSpans(content, 'bold');
    if (spans) {
      return {
        length: closing + marker.length,
        spans,
      };
    }
    const length = closing < 0 ? remaining.length : closing + marker.length;
    return {
      length,
      spans: [{ text: remaining.slice(0, length), style: 'plain' }],
    };
  }

  for (const marker of ['*', '_'] as const) {
    if (!remaining.startsWith(marker) || remaining.startsWith(marker.repeat(2))) continue;
    const previous = value[start - 1];
    if (marker === '_' && previous !== undefined && /[\p{L}\p{N}]/u.test(previous)) continue;
    const closing = remaining.indexOf(marker, 1);
    const content = closing < 0 ? '' : remaining.slice(1, closing);
    const after = closing < 0 ? undefined : remaining[closing + 1];
    const spans = emphasisMarkdownSpans(content, 'italic');
    if (spans && !(marker === '_' && after !== undefined && /[\p{L}\p{N}]/u.test(after))) {
      return {
        length: closing + 1,
        spans,
      };
    }
    const length = closing < 0 ? remaining.length : closing + 1;
    return {
      length,
      spans: [{ text: remaining.slice(0, length), style: 'plain' }],
    };
  }

  return null;
}

function parseInlineMarkdown(value: string): MarkdownSpan[] {
  const spans: MarkdownSpan[] = [];
  let index = 0;
  while (index < value.length) {
    if (value[index] === '\\' && index + 1 < value.length) {
      appendMarkdownSpan(spans, value.slice(index, index + 2), 'plain');
      index += 2;
      continue;
    }
    const match = inlineMarkdownMatch(value, index);
    if (match) {
      for (const span of match.spans) appendMarkdownSpan(spans, span.text, span.style);
      index += match.length;
      continue;
    }
    appendMarkdownSpan(spans, value[index], 'plain');
    index += 1;
  }
  return spans;
}

function styleMarkdownText(value: string, inlineStyle: MarkdownInlineStyle, blockStyle: MarkdownBlockStyle): string {
  let styled = value;
  if (blockStyle === 'heading') styled = chalk.cyan.bold(styled);
  else if (blockStyle === 'quote') styled = chalk.dim(styled);
  else if (blockStyle === 'code') styled = chalk.gray(styled);

  switch (inlineStyle) {
    case 'bold':
      return chalk.bold(styled);
    case 'italic':
      return chalk.italic(styled);
    case 'code':
      return chalk.cyan(styled);
    case 'bold-code':
      return chalk.bold.cyan(styled);
    case 'italic-code':
      return chalk.italic.cyan(styled);
    case 'link-label':
      return chalk.underline(styled);
    case 'link-url':
      return chalk.dim(styled);
    case 'plain':
      return styled;
  }
}

function markdownUnits(spans: readonly MarkdownSpan[]): MarkdownUnit[] {
  const units: MarkdownUnit[] = [];
  for (const span of spans) {
    for (const { segment } of GRAPHEME_SEGMENTER.segment(span.text)) {
      units.push({ text: segment, style: span.style, width: stringWidth(segment) });
    }
  }
  return units;
}

function renderMarkdownUnits(units: readonly MarkdownUnit[], blockStyle: MarkdownBlockStyle): string {
  const spans: MarkdownSpan[] = [];
  for (const unit of units) appendMarkdownSpan(spans, unit.text, unit.style);
  return spans.map((span) => styleMarkdownText(span.text, span.style, blockStyle)).join('');
}

function wrapMarkdownSpans(
  spans: readonly MarkdownSpan[],
  width: number,
  firstPrefix = '',
  continuationPrefix = firstPrefix,
  blockStyle: MarkdownBlockStyle = 'plain',
): string[] {
  const units = markdownUnits(spans);
  if (units.length === 0) return [firstPrefix];

  const lines: string[] = [];
  let offset = 0;
  let first = true;
  while (offset < units.length) {
    const lineStart = offset;
    const prefix = first ? firstPrefix : continuationPrefix;
    const availableWidth = Math.max(1, width - stringWidth(visibleText(prefix)));
    let usedWidth = 0;
    let end = offset;
    let lastSpace = -1;
    while (end < units.length && usedWidth + units[end].width <= availableWidth) {
      usedWidth += units[end].width;
      if (units[end].text === ' ') lastSpace = end;
      end += 1;
    }

    if (end === units.length) {
      lines.push(prefix + renderMarkdownUnits(units.slice(offset), blockStyle));
      break;
    }

    let lineEnd: number;
    if (lastSpace > offset) {
      lineEnd = lastSpace;
      offset = lastSpace + 1;
      while (units[offset]?.text === ' ') offset += 1;
    } else {
      lineEnd = Math.max(offset + 1, end);
      offset = lineEnd;
    }
    lines.push(prefix + renderMarkdownUnits(units.slice(lineStart, lineEnd), blockStyle));
    first = false;
  }
  return lines;
}

function renderMarkdownLine(
  content: string,
  width: number,
  firstPrefix = '',
  continuationPrefix = firstPrefix,
  blockStyle: MarkdownBlockStyle = 'plain',
): string[] {
  return wrapMarkdownSpans(parseInlineMarkdown(content), width, firstPrefix, continuationPrefix, blockStyle);
}

function renderMarkdown(text: string, width: number): string[] {
  const sourceLines = text.replace(/\r\n/g, '\n').split('\n');
  const rendered: string[] = [];
  for (let index = 0; index < sourceLines.length; index += 1) {
    const sourceLine = sourceLines[index];
    if (!sourceLine) {
      rendered.push('');
      continue;
    }

    const fence = sourceLine.match(/^ {0,3}(`{3,}|~{3,})(?:\s*([\w.+:-]+))?\s*$/);
    if (fence) {
      const closingFencePattern = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      const closingIndex = sourceLines.findIndex(
        (candidate, candidateIndex) => candidateIndex > index && closingFencePattern.test(candidate),
      );
      if (closingIndex > index) {
        if (fence[2]) rendered.push(chalk.dim(`[${fence[2]}]`));
        for (const codeLine of sourceLines.slice(index + 1, closingIndex)) {
          if (!codeLine) rendered.push(chalk.dim('│'));
          else {
            rendered.push(
              ...wrapMarkdownSpans(
                [{ text: codeLine, style: 'plain' }],
                width,
                chalk.dim('│ '),
                chalk.dim('│ '),
                'code',
              ),
            );
          }
        }
        index = closingIndex;
        continue;
      }
    }

    const heading = sourceLine.match(/^ {0,3}#{1,6}[ \t]+(.+?)(?:[ \t]+#+[ \t]*)?$/);
    if (heading) {
      rendered.push(...renderMarkdownLine(heading[1], width, '', '', 'heading'));
      continue;
    }

    const quote = sourceLine.match(/^ {0,3}> ?(.*)$/);
    if (quote) {
      if (!quote[1]) rendered.push(chalk.dim('│'));
      else {
        rendered.push(...renderMarkdownLine(quote[1], width, chalk.dim('│ '), chalk.dim('│ '), 'quote'));
      }
      continue;
    }

    const unorderedList = sourceLine.match(/^(\s{0,3})[-+*]\s+(.+)$/);
    if (unorderedList) {
      const prefix = `${unorderedList[1]}${chalk.cyan('•')} `;
      rendered.push(
        ...renderMarkdownLine(unorderedList[2], width, prefix, ' '.repeat(stringWidth(visibleText(prefix)))),
      );
      continue;
    }

    const orderedList = sourceLine.match(/^(\s{0,3})(\d+)[.)]\s+(.+)$/);
    if (orderedList) {
      const prefix = `${orderedList[1]}${chalk.cyan(`${orderedList[2]}.`)} `;
      rendered.push(...renderMarkdownLine(orderedList[3], width, prefix, ' '.repeat(stringWidth(visibleText(prefix)))));
      continue;
    }

    rendered.push(...renderMarkdownLine(sourceLine, width));
  }
  return rendered;
}

export function renderMarkdownPreview(text: string, width: number): string[] {
  try {
    return renderMarkdown(text, width);
  } catch {
    return [
      ...wrapText('Markdown styling unavailable; showing source.', width).map((line) => chalk.dim(line)),
      ...wrapText(text, width),
    ];
  }
}

export function renderMarkdownPreviewLabel(text: string, emptyLabel: string): string {
  const firstLine = text.split('\n')[0] || emptyLabel;
  try {
    return renderMarkdown(firstLine, Math.max(10, stringWidth(firstLine) + 2))[0] || emptyLabel;
  } catch {
    return firstLine;
  }
}

export function renderMarkdownTitleLabel(text: string, emptyLabel: string): string {
  const firstLine =
    text
      .split('\n')
      .find((line) => line.trim())
      ?.trim() || emptyLabel;
  const boldTitle = firstLine.match(/^(\*\*|__)(.+?)\1\s*:/);
  const title = boldTitle?.[2] ?? firstLine;
  return renderMarkdownPreviewLabel(title, emptyLabel);
}
