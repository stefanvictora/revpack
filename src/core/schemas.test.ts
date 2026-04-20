import { describe, it, expect } from 'vitest';
import { configSchema } from '../core/schemas.js';

describe('configSchema', () => {
  it('validates a complete gitlab config', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'glpat-abc123',
      bundleDir: '.review-assist',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe('gitlab');
      expect(result.data.gitlabUrl).toBe('https://gitlab.example.com');
    }
  });

  it('applies default bundleDir', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'token',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bundleDir).toBe('.review-assist');
    }
  });

  it('rejects invalid provider', () => {
    const result = configSchema.safeParse({
      provider: 'bitbucket',
      gitlabUrl: 'https://gitlab.example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid gitlabUrl', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
      gitlabUrl: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('allows minimal config', () => {
    const result = configSchema.safeParse({
      provider: 'gitlab',
    });
    expect(result.success).toBe(true);
  });
});
