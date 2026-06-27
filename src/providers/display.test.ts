import { describe, expect, it } from 'vitest';
import { formatTargetDisplayId } from './display.js';

describe('provider display helpers', () => {
  it('formats provider-native target ids', () => {
    expect(formatTargetDisplayId({ provider: 'gitlab', targetType: 'merge_request', targetId: '42' })).toBe('!42');
    expect(formatTargetDisplayId({ provider: 'github', targetType: 'pull_request', targetId: '42' })).toBe('#42');
    expect(formatTargetDisplayId({ provider: 'bitbucket-cloud', targetType: 'pull_request', targetId: '42' })).toBe(
      '#42',
    );
    expect(formatTargetDisplayId({ provider: 'local', targetType: 'local_review', targetId: 'main...feature' })).toBe(
      'main...feature',
    );
  });
});
