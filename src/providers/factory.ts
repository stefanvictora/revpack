import type { ReviewProvider } from './provider.js';
import { GitLabProvider } from './gitlab/gitlab-provider.js';
import type { AppConfig } from '../core/schemas.js';
import { ConfigError } from '../core/errors.js';

export function createProvider(config: AppConfig): ReviewProvider {
  switch (config.provider) {
    case 'gitlab': {
      if (!config.gitlabUrl) throw new ConfigError('gitlabUrl is required for GitLab provider');
      if (!config.gitlabToken) throw new ConfigError('gitlabToken is required for GitLab provider');
      return new GitLabProvider(config.gitlabUrl, config.gitlabToken, {
        caFile: config.caFile,
        tlsVerify: config.tlsVerify,
      });
    }
    case 'github':
      throw new ConfigError('GitHub provider is not yet implemented');
    default:
      throw new ConfigError(`Unknown provider: ${config.provider}`);
  }
}
