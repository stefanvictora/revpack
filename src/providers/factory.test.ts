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
      bundleDir: '.revkit',
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('gitlab');
  });

  it('throws on missing gitlabUrl', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabToken: 'glpat-xxx',
      bundleDir: '.revkit',
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on missing gitlabToken', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      bundleDir: '.revkit',
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on github (not implemented)', () => {
    const config: AppConfig = {
      provider: 'github',
      bundleDir: '.revkit',
    };
    expect(() => createProvider(config)).toThrow('not yet implemented');
  });
});
