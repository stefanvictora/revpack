import type { ReviewProvider } from './provider.js';
import { GitLabProvider } from './gitlab/gitlab-provider.js';
import { GitHubProvider } from './github/github-provider.js';
import { BitbucketCloudProvider } from './bitbucket/bitbucket-cloud-provider.js';
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
        sshClone: config.sshClone,
      });
    }
    case 'github': {
      if (!config.token) throw new ConfigError('token is required for GitHub provider (set the configured tokenEnv)');
      return new GitHubProvider(config.url, config.token, {
        caFile: config.caFile,
        tlsVerify: config.tlsVerify,
        sshClone: config.sshClone,
      });
    }
    case 'bitbucket-cloud': {
      if (config.url && config.url.replace(/\/+$/, '') !== 'https://bitbucket.org') {
        throw new ConfigError(
          'Bitbucket Cloud profiles must use https://bitbucket.org. Bitbucket Server/Data Center URLs are not supported by provider "bitbucket-cloud".',
        );
      }
      if (!config.email) {
        throw new ConfigError(
          'email is required for Bitbucket Cloud provider (set the configured emailEnv to your Atlassian account email)',
        );
      }
      if (!config.token) {
        throw new ConfigError('token is required for Bitbucket Cloud provider (set the configured tokenEnv)');
      }
      return new BitbucketCloudProvider(config.email, config.token, {
        caFile: config.caFile,
        tlsVerify: config.tlsVerify,
        sshClone: config.sshClone,
      });
    }
    default:
      throw new ConfigError(`Unknown provider: ${config.provider as string}`);
  }
}
