import { describe, it, expect } from 'vitest';
import { createProvider } from '../providers/factory.js';
import { ConfigError } from '../core/errors.js';
import type { AppConfig } from '../core/schemas.js';

describe('createProvider', () => {
  it('creates a GitLab provider', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'glpat-xxx',
      bundleDir: '.review-assist',
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('gitlab');
  });

  it('throws on missing gitlabUrl', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabToken: 'glpat-xxx',
      bundleDir: '.review-assist',
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on missing gitlabToken', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      bundleDir: '.review-assist',
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on github (not implemented)', () => {
    const config: AppConfig = {
      provider: 'github',
      bundleDir: '.review-assist',
    };
    expect(() => createProvider(config)).toThrow('not yet implemented');
  });
});
