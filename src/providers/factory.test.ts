import { describe, it, expect } from 'vitest';
import { createProvider } from '../providers/factory.js';
import { ConfigError } from '../core/errors.js';
import type { ResolvedAppConfig } from '../config/types.js';

describe('createProvider', () => {
  it('creates a GitLab provider', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      gitlabToken: 'glpat-xxx',
      tlsVerify: true,
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('gitlab');
  });

  it('throws on missing gitlabUrl', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      gitlabToken: 'glpat-xxx',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on missing gitlabToken', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
  });

  it('throws on github (not implemented)', () => {
    const config: ResolvedAppConfig = {
      provider: 'github',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow('not yet implemented');
  });
});
