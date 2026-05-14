import { describe, expect, it } from 'vitest';
import { formatTargetDisplayId, formatTargetKind } from './display.js';

describe('display helpers', () => {
  it('formats provider-native target ids', () => {
    expect(formatTargetDisplayId({ provider: 'gitlab', targetType: 'merge_request', targetId: '42' })).toBe('!42');
    expect(formatTargetDisplayId({ provider: 'github', targetType: 'pull_request', targetId: '42' })).toBe('#42');
    expect(formatTargetDisplayId({ provider: 'local', targetType: 'local_review', targetId: 'main...feature' })).toBe(
      'main...feature',
    );
  });

  it('formats target kinds', () => {
    expect(formatTargetKind({ targetType: 'merge_request' })).toBe('MR');
    expect(formatTargetKind({ targetType: 'pull_request' })).toBe('PR');
    expect(formatTargetKind({ targetType: 'local_review' })).toBe('Local review');
  });
});
