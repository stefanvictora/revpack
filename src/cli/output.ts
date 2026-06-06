import chalk from 'chalk';

const COMMAND_LINE_PATTERN = /^\s*(?:revpack\b|cd\b|export\b|\/revpack-review\b)/u;

export function formatGuidanceLine(line: string): string {
  if (line === '') return '';
  return COMMAND_LINE_PATTERN.test(line) ? line : chalk.dim(line);
}
