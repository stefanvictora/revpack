import { describe, expect, it } from 'vitest';
import { sameCommitSha } from './commits.js';

describe('sameCommitSha', () => {
  it('treats abbreviated and full commit hashes as the same commit', () => {
    expect(sameCommitSha('fb0aebbd3d5b', 'fb0aebbd3d5b858c6024745659c9f4211d186589')).toBe(true);
    expect(sameCommitSha('fb0aebbd3d5b858c6024745659c9f4211d186589', 'fb0aebbd3d5b')).toBe(true);
  });

  it('does not prefix-match non-commit placeholders', () => {
    expect(sameCommitSha('bbb', 'bbbbbbbb')).toBe(false);
  });
});
