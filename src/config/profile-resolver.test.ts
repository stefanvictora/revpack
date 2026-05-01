import { describe, it, expect } from 'vitest';
import { ProfileResolver } from './profile-resolver.js';
import type { AppConfig } from './types.js';

describe('ProfileResolver', () => {
  const resolver = new ProfileResolver();

  it('selects profile by matching origin remote', () => {
    const config: AppConfig = {
      profiles: {
        'customer-a': {
          provider: 'gitlab',
          remoteUrlPatterns: ['gitlab.customer-a.local'],
          gitlabUrl: 'https://gitlab.customer-a.local',
        },
        'customer-b': {
          provider: 'gitlab',
          remoteUrlPatterns: ['gitlab.customer-b.local'],
          gitlabUrl: 'https://gitlab.customer-b.local',
        },
      },
    };
    const result = resolver.resolve(config, ['git@gitlab.customer-a.local:group/project.git']);
    expect(result.profileName).toBe('customer-a');
    expect(result.profile.gitlabUrl).toBe('https://gitlab.customer-a.local');
  });

  it('falls back to defaultProfile', () => {
    const config: AppConfig = {
      defaultProfile: 'customer-b',
      profiles: {
        'customer-a': {
          provider: 'gitlab',
          remoteUrlPatterns: ['gitlab.customer-a.local'],
          gitlabUrl: 'https://gitlab.customer-a.local',
        },
        'customer-b': {
          provider: 'gitlab',
          gitlabUrl: 'https://gitlab.customer-b.local',
        },
      },
    };
    const result = resolver.resolve(config, ['git@github.com:user/repo.git']);
    expect(result.profileName).toBe('customer-b');
  });

  it('fails on multiple matching profiles', () => {
    const config: AppConfig = {
      profiles: {
        'profile-1': {
          provider: 'gitlab',
          remoteUrlPatterns: ['example.local'],
        },
        'profile-2': {
          provider: 'gitlab',
          remoteUrlPatterns: ['example.local'],
        },
      },
    };
    expect(() => resolver.resolve(config, ['git@example.local:group/project.git'])).toThrow(
      /Multiple profiles match/,
    );
  });

  it('falls back to flat root config', () => {
    const config: AppConfig = {
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
    };
    const result = resolver.resolve(config, []);
    expect(result.profileName).toBeNull();
    expect(result.profile.provider).toBe('gitlab');
    expect(result.profile.gitlabUrl).toBe('https://gitlab.example.com');
  });

  it('fails when no provider config can be resolved', () => {
    const config: AppConfig = {};
    expect(() => resolver.resolve(config, [])).toThrow(/No provider configuration found/);
  });

  it('selects explicit profile by name', () => {
    const config: AppConfig = {
      profiles: {
        'my-profile': {
          provider: 'gitlab',
          gitlabUrl: 'https://gitlab.mine.com',
        },
      },
    };
    const result = resolver.resolve(config, [], 'my-profile');
    expect(result.profileName).toBe('my-profile');
    expect(result.profile.gitlabUrl).toBe('https://gitlab.mine.com');
  });

  it('errors for unknown explicit profile', () => {
    const config: AppConfig = {
      profiles: {
        'my-profile': { provider: 'gitlab' },
      },
    };
    expect(() => resolver.resolve(config, [], 'nonexistent')).toThrow(/not found/);
  });
});
