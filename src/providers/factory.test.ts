import { describe, it, expect } from 'vitest';
import { createProvider } from '../providers/factory.js';
import { ConfigError } from '../core/errors.js';
import type { ResolvedAppConfig } from '../config/types.js';

describe('createProvider', () => {
  it('creates a GitLab provider', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      url: 'https://gitlab.example.com',
      token: 'glpat-xxx',
      sshClone: true,
      tlsVerify: true,
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('gitlab');
    expect(provider.getCloneUrl('group/project')).toBe('git@gitlab.example.com:group/project.git');
  });

  it('throws on missing url', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      token: 'glpat-xxx',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
    expect(() => createProvider(config)).toThrow('url is required for GitLab provider');
  });

  it('throws on missing token', () => {
    const config: ResolvedAppConfig = {
      provider: 'gitlab',
      url: 'https://gitlab.example.com',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow(ConfigError);
    expect(() => createProvider(config)).toThrow('token is required for GitLab provider');
  });

  it('creates a GitHub provider', () => {
    const config: ResolvedAppConfig = {
      provider: 'github',
      url: 'https://github.com',
      token: 'ghp-xxx',
      sshClone: true,
      tlsVerify: true,
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('github');
    expect(provider.getCloneUrl('owner/repo')).toBe('git@github.com:owner/repo.git');
  });

  it('creates a GitHub provider with the default GitHub URL', () => {
    const config: ResolvedAppConfig = {
      provider: 'github',
      token: 'ghp-xxx',
      tlsVerify: true,
    };
    const provider = createProvider(config);
    expect(provider.providerType).toBe('github');
  });

  it('throws on missing github token', () => {
    const config: ResolvedAppConfig = {
      provider: 'github',
      tlsVerify: true,
    };
    expect(() => createProvider(config)).toThrow('token is required for GitHub provider');
  });

  it('throws on unknown providers', () => {
    const config = {
      provider: 'bitbucket',
      token: 'token',
      tlsVerify: true,
    } as unknown as ResolvedAppConfig;

    expect(() => createProvider(config)).toThrow(ConfigError);
    expect(() => createProvider(config)).toThrow('Unknown provider: bitbucket');
  });
});
