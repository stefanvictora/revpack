import type { ReviewProvider } from './provider.js';
import { GitLabProvider } from './gitlab/gitlab-provider.js';
import type { ResolvedAppConfig } from '../config/types.js';
import { ConfigError } from '../core/errors.js';

export function createProvider(config: ResolvedAppConfig): ReviewProvider {
  switch (config.provider) {
    case 'gitlab': {
      if (!config.url) throw new ConfigError('url is required for GitLab provider');
      if (!config.token) throw new ConfigError('token is required for GitLab provider (set the configured tokenEnv)');
      return new GitLabProvider(config.url, config.token, {
        caFile: config.caFile,
        tlsVerify: config.tlsVerify,
      });
    }
    case 'github':
      throw new ConfigError('GitHub provider is not yet implemented');
    default:
      throw new ConfigError(`Unknown provider: ${config.provider as string}`);
  }
}
