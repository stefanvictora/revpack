import chalk from 'chalk';

const INLINE_CODE_PATTERN = /`([^`\r\n]+)`/gu;

export function formatGuidanceLine(line: string): string {
  if (line === '') return '';

  let result = '';
  let lastIndex = 0;
  let foundInlineCode = false;

  for (const match of line.matchAll(INLINE_CODE_PATTERN)) {
    foundInlineCode = true;

    const index = match.index ?? 0;
    const fullMatch = match[0];
    const code = match[1];

    result += chalk.dim(line.slice(lastIndex, index));
    result += code;
    lastIndex = index + fullMatch.length;
  }

  if (!foundInlineCode) {
    return chalk.dim(line);
  }

  result += chalk.dim(line.slice(lastIndex));
  return result;
}
