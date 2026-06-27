import { ConfigError } from '../core/errors.js';
import type { ProviderType } from './types.js';

export function normalizeProviderInput(value: string): ProviderType {
  const provider = value.trim().toLowerCase();
  if (provider === 'gitlab' || provider === 'github' || provider === 'bitbucket-cloud') {
    return provider;
  }

  throw new ConfigError(`Invalid provider: "${value}". Must be "gitlab", "github", or "bitbucket-cloud".`);
}

export function normalizeProviderUrlInput(value: string): string {
  const url = value.trim();
  if (!url) return '';

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    const hint = /^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(url) ? ` Include the scheme, for example "https://${url}".` : '';
    throw new ConfigError(
      `Invalid provider URL: "${value}". Expected an absolute URL like "https://gitlab.com".${hint}`,
    );
  }

  if (
    (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new ConfigError(`Invalid provider URL: "${value}". Expected an absolute URL like "https://gitlab.com".`);
  }

  return parsed.origin;
}

export function inferProviderFromUrl(value: string): ProviderType | null {
  const host = parseProviderUrlHost(value);
  if (!host) return null;
  if (host === 'bitbucket.org') return 'bitbucket-cloud';
  if (host === 'github.com' || host.endsWith('.github.com') || host.startsWith('github.')) return 'github';
  if (host === 'gitlab.com' || host.startsWith('gitlab.') || host.includes('.gitlab.')) return 'gitlab';
  return null;
}

export function deriveProfileNameFromProviderUrl(value: string): string {
  const host = parseProviderUrlHost(value);
  return host ? host.split('.')[0] : '';
}

export function isManagedCloudProvider(url: string, provider: ProviderType): boolean {
  const host = parseProviderUrlHost(url);
  return (
    (provider === 'github' && host === 'github.com') ||
    (provider === 'gitlab' && host === 'gitlab.com') ||
    (provider === 'bitbucket-cloud' && host === 'bitbucket.org')
  );
}

export function validateProviderUrlForProvider(url: string | undefined, provider: ProviderType): void {
  if (provider !== 'bitbucket-cloud' || !url) return;

  const host = parseProviderUrlHost(url);
  if (host !== 'bitbucket.org') {
    throw new ConfigError(
      'Bitbucket Cloud profiles must use https://bitbucket.org. Bitbucket Server/Data Center URLs are not supported by provider "bitbucket-cloud".',
    );
  }
}

export function isTokenEnvResolved(tokenEnv: string): boolean {
  const value = process.env[tokenEnv];
  return Boolean(value && value.length > 0);
}

function parseProviderUrlHost(value: string): string {
  if (!value.trim()) return '';
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}
