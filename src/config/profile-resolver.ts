import { ConfigError } from '../core/errors.js';
import type { AppConfig, RevkitProfile } from './types.js';

export interface ProfileResolutionResult {
  profile: RevkitProfile;
  profileName: string | null;
}

/**
 * Resolves the active profile from config based on git remote URLs.
 */
export class ProfileResolver {
  /**
   * Resolve the active profile.
   *
   * Resolution order:
   * 1. Explicit profile name (--profile CLI option)
   * 2. Profile whose remoteUrlPatterns match the current repository remote URL
   * 3. defaultProfile from config
   * 4. Flat root config fallback
   * 5. Fail with a clear error
   */
  resolve(
    config: AppConfig,
    remoteUrls: string[],
    explicitProfile?: string,
  ): ProfileResolutionResult {
    // 1. Explicit profile selection
    if (explicitProfile) {
      const profile = config.profiles?.[explicitProfile];
      if (!profile) {
        throw new ConfigError(
          `Profile "${explicitProfile}" not found. Available: ${Object.keys(config.profiles ?? {}).join(', ') || '(none)'}`,
        );
      }
      return { profile, profileName: explicitProfile };
    }

    // 2. Match by remote URL patterns
    if (config.profiles && remoteUrls.length > 0) {
      const matches: { name: string; profile: RevkitProfile }[] = [];

      for (const [name, profile] of Object.entries(config.profiles)) {
        if (profile.remoteUrlPatterns && profile.remoteUrlPatterns.length > 0) {
          const matched = profile.remoteUrlPatterns.some((pattern) =>
            remoteUrls.some((url) => url.includes(pattern)),
          );
          if (matched) {
            matches.push({ name, profile });
          }
        }
      }

      if (matches.length === 1) {
        return { profile: matches[0].profile, profileName: matches[0].name };
      }

      if (matches.length > 1) {
        const names = matches.map((m) => m.name).join(', ');
        throw new ConfigError(
          `Multiple profiles match the current repository remote: ${names}. Use --profile to select one.`,
        );
      }
    }

    // 3. Default profile
    if (config.defaultProfile && config.profiles?.[config.defaultProfile]) {
      return {
        profile: config.profiles[config.defaultProfile],
        profileName: config.defaultProfile,
      };
    }

    // 4. Flat root config fallback
    if (config.provider) {
      const fallback: RevkitProfile = {
        provider: config.provider,
        gitlabUrl: config.gitlabUrl,
        gitlabTokenSource: config.gitlabTokenSource,
        githubTokenSource: config.githubTokenSource,
        defaultRepository: config.defaultRepository,
        caFile: config.caFile,
        tlsVerify: config.tlsVerify,
      };
      return { profile: fallback, profileName: null };
    }

    // 5. Fail
    throw new ConfigError(
      'No provider configuration found. Run `revkit setup` or configure a profile in ~/.config/revkit/config.json',
    );
  }
}
