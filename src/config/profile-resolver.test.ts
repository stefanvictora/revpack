import { describe, it, expect } from 'vitest';
import { ProfileResolver, getProfileRemotePatterns } from './profile-resolver.js';
import type { RevpackConfig, RevpackProfile } from './types.js';

describe('getProfileRemotePatterns', () => {
  it('derives host from URL', () => {
    const profile: RevpackProfile = { provider: 'gitlab', url: 'https://gitlab.work.com/api/v4' };
    const patterns = getProfileRemotePatterns(profile);
    expect(patterns).toEqual([{ pattern: 'gitlab.work.com', source: 'url-derived' }]);
  });

  it('includes explicit remotePatterns', () => {
    const profile: RevpackProfile = { provider: 'gitlab', remotePatterns: ['my-gitlab.internal'] };
    const patterns = getProfileRemotePatterns(profile);
    expect(patterns).toEqual([{ pattern: 'my-gitlab.internal', source: 'remote-pattern' }]);
  });

  it('combines URL host and remotePatterns, deduplicating', () => {
    const profile: RevpackProfile = {
      provider: 'gitlab',
      url: 'https://gitlab.work.com',
      remotePatterns: ['gitlab.work.com', 'extra.host.com'],
    };
    const patterns = getProfileRemotePatterns(profile);
    expect(patterns).toEqual([
      { pattern: 'gitlab.work.com', source: 'url-derived' },
      { pattern: 'extra.host.com', source: 'remote-pattern' },
    ]);
  });

  it('returns empty for profile without URL or remotePatterns', () => {
    const profile: RevpackProfile = { provider: 'github' };
    expect(getProfileRemotePatterns(profile)).toEqual([]);
  });

  it('handles invalid URL gracefully', () => {
    const profile: RevpackProfile = { provider: 'gitlab', url: 'not-a-url' };
    expect(getProfileRemotePatterns(profile)).toEqual([]);
  });
});

describe('ProfileResolver', () => {
  const resolver = new ProfileResolver();

  describe('explicit profile', () => {
    it('returns explicit profile by name', () => {
      const config: RevpackConfig = {
        profiles: {
          work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
        },
      };
      const result = resolver.resolve(config, [], 'work');
      expect(result.profileName).toBe('work');
      expect(result.matchedBy).toBe('explicit');
      expect(result.profile.provider).toBe('gitlab');
    });

    it('throws when explicit profile not found', () => {
      const config: RevpackConfig = {
        profiles: { work: { provider: 'gitlab' } },
      };
      expect(() => resolver.resolve(config, [], 'nope')).toThrow(/not found/);
    });
  });

  describe('URL-derived matching', () => {
    it('matches by URL host against git remote', () => {
      const config: RevpackConfig = {
        profiles: {
          work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
        },
      };
      const result = resolver.resolve(config, ['git@gitlab.work.com:team/repo.git']);
      expect(result.profileName).toBe('work');
      expect(result.matchedBy).toBe('remote-match');
      expect(result.matchedPattern).toBe('gitlab.work.com');
      expect(result.matchSource).toBe('url-derived');
    });

    it('matches HTTPS remote by host', () => {
      const config: RevpackConfig = {
        profiles: {
          work: { provider: 'gitlab', url: 'https://gitlab.example.org/api/v4' },
        },
      };
      const result = resolver.resolve(config, ['https://gitlab.example.org/team/repo.git']);
      expect(result.matchedPattern).toBe('gitlab.example.org');
      expect(result.matchSource).toBe('url-derived');
    });
  });

  describe('remotePatterns matching', () => {
    it('matches by explicit remotePattern', () => {
      const config: RevpackConfig = {
        profiles: {
          custom: { provider: 'github', remotePatterns: ['my-github'] },
        },
      };
      const result = resolver.resolve(config, ['git@my-github:org/repo.git']);
      expect(result.profileName).toBe('custom');
      expect(result.matchedPattern).toBe('my-github');
      expect(result.matchSource).toBe('remote-pattern');
    });

    it('prefers URL host over remotePatterns when both match', () => {
      const config: RevpackConfig = {
        profiles: {
          work: {
            provider: 'gitlab',
            url: 'https://gitlab.work.com',
            remotePatterns: ['gitlab.work.com'],
          },
        },
      };
      const result = resolver.resolve(config, ['git@gitlab.work.com:team/repo.git']);
      expect(result.matchSource).toBe('url-derived');
    });
  });

  describe('no match', () => {
    it('throws when no profile matches', () => {
      const config: RevpackConfig = {
        profiles: {
          work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
        },
      };
      expect(() => resolver.resolve(config, ['git@other.com:team/repo.git'])).toThrow(/No profile matched/);
    });

    it('throws when no remotes and no explicit profile', () => {
      const config: RevpackConfig = {
        profiles: { work: { provider: 'gitlab', url: 'https://gitlab.work.com' } },
      };
      expect(() => resolver.resolve(config, [])).toThrow(/No profile matched/);
    });
  });

  describe('ambiguous match', () => {
    it('throws when multiple profiles match', () => {
      const config: RevpackConfig = {
        profiles: {
          a: { provider: 'gitlab', url: 'https://shared.host.com' },
          b: { provider: 'github', remotePatterns: ['shared.host.com'] },
        },
      };
      expect(() => resolver.resolve(config, ['git@shared.host.com:team/repo.git'])).toThrow(/Multiple profiles match/);
    });
  });
});
