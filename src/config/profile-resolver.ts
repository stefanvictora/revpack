import { ConfigError } from '../core/errors.js';
import type { RevkitConfig, RevkitProfile, ProfileResolutionResult } from './types.js';

/**
 * Extract the host from a URL. Returns undefined if parsing fails.
 */
function tryExtractHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Build candidate remote patterns for a profile:
 * 1. Host derived from profile.url (if parseable)
 * 2. All configured profile.remotePatterns
 */
export function getProfileRemotePatterns(
  profile: RevkitProfile,
): { pattern: string; source: 'url-derived' | 'remote-pattern' }[] {
  const patterns: { pattern: string; source: 'url-derived' | 'remote-pattern' }[] = [];
  const seen = new Set<string>();

  const host = tryExtractHost(profile.url);
  if (host && !seen.has(host)) {
    seen.add(host);
    patterns.push({ pattern: host, source: 'url-derived' });
  }

  for (const p of profile.remotePatterns ?? []) {
    const normalized = p.trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      patterns.push({ pattern: normalized, source: 'remote-pattern' });
    }
  }

  return patterns;
}

/**
 * Resolves the active profile from config based on git remote URLs.
 *
 * Resolution order:
 * 1. Explicit profile name (--profile CLI option)
 * 2. Profile whose candidate patterns (URL host + remotePatterns) match a git remote
 * 3. Fail with a clear error and next-step hint
 */
export class ProfileResolver {
  resolve(config: RevkitConfig, remoteUrls: string[], explicitProfile?: string): ProfileResolutionResult {
    const profiles = config.profiles ?? {};

    // 1. Explicit profile selection
    if (explicitProfile) {
      const profile = profiles[explicitProfile];
      if (!profile) {
        const available = Object.keys(profiles);
        throw new ConfigError(
          `Profile "${explicitProfile}" not found. Available: ${available.length > 0 ? available.join(', ') : '(none)'}`,
        );
      }
      return { profile, profileName: explicitProfile, matchedBy: 'explicit' };
    }

    // 2. Match by candidate patterns (URL host + remotePatterns)
    if (remoteUrls.length > 0) {
      const matches: {
        name: string;
        profile: RevkitProfile;
        pattern: string;
        source: 'url-derived' | 'remote-pattern';
      }[] = [];

      for (const [name, profile] of Object.entries(profiles)) {
        const candidates = getProfileRemotePatterns(profile);
        for (const { pattern, source } of candidates) {
          const matched = remoteUrls.some((url) => url.includes(pattern));
          if (matched) {
            matches.push({ name, profile, pattern, source });
            break;
          }
        }
      }

      if (matches.length === 1) {
        return {
          profile: matches[0].profile,
          profileName: matches[0].name,
          matchedBy: 'remote-match',
          matchedPattern: matches[0].pattern,
          matchSource: matches[0].source,
        };
      }

      if (matches.length > 1) {
        const names = matches.map((m) => m.name).join(', ');
        throw new ConfigError(
          `Multiple profiles match the current repository remote: ${names}. Use --profile to select one.`,
        );
      }
    }

    // 3. Fail
    throw new ConfigError(
      'No profile matched the current repository.\n\nRun `revkit config setup` to create a profile, or use `--profile <name>` to select one explicitly.',
    );
  }
}
