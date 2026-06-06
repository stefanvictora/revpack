import { describe, expect, it } from 'vitest';
import chalk from 'chalk';
import { formatGuidanceLine } from './output.js';

describe('formatGuidanceLine', () => {
  it('does not dim recommended commands', () => {
    expect(formatGuidanceLine('  revpack prepare')).toBe('  revpack prepare');
    expect(formatGuidanceLine('  revpack publish all')).toBe('  revpack publish all');
    expect(formatGuidanceLine('  cd C:\\repo')).toBe('  cd C:\\repo');
    expect(formatGuidanceLine('  export REVPACK_GITHUB_TOKEN=...')).toBe('  export REVPACK_GITHUB_TOKEN=...');
    expect(formatGuidanceLine('    /revpack-review')).toBe('    /revpack-review');
  });

  it('dims prose guidance', () => {
    expect(formatGuidanceLine('Next:')).toBe(chalk.dim('Next:'));
  });
});
