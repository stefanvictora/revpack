import { describe, expect, it } from 'vitest';
import { formatTargetKind } from './display.js';

describe('display helpers', () => {
  it('formats target kinds', () => {
    expect(formatTargetKind({ targetType: 'merge_request' })).toBe('MR');
    expect(formatTargetKind({ targetType: 'pull_request' })).toBe('PR');
    expect(formatTargetKind({ targetType: 'local_review' })).toBe('Local review');
  });
});
