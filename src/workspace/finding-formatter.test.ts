import { describe, expect, it } from 'vitest';
import { buildFindingHeader, renderPublishFindingBody } from './finding-formatter.js';

describe('finding formatter', () => {
  it.each([
    ['blocker', '🔴'],
    ['high', '🔴'],
    ['medium', '🟡'],
    ['low', '🟢'],
    ['info', '🟢'],
    ['nit', '🟢'],
  ])('uses the configured icon for %s findings', (severity, icon) => {
    expect(buildFindingHeader(severity, 'correctness')).toBe(`_${icon} ${capitalize(severity)}_ | _correctness_\n\n`);
  });

  it('uses the medium icon for unknown severities', () => {
    expect(buildFindingHeader('unknown', 'maintainability')).toBe('_🟡 Unknown_ | _maintainability_\n\n');
  });

  it('renders the publish body with the finding header', () => {
    expect(
      renderPublishFindingBody({
        severity: 'high',
        category: 'security',
        body: 'Do not log credentials.',
      }),
    ).toBe('_🔴 High_ | _security_\n\nDo not log credentials.');
  });
});

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
