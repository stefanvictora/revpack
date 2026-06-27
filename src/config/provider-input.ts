import { ConfigError } from '../core/errors.js';
import type { ProviderType } from './types.js';

export function normalizeProviderInput(value: string): ProviderType {
  const provider = value.trim().toLowerCase();
  if (provider === 'gitlab' || provider === 'github') {
    return provider;
  }

  throw new ConfigError(`Invalid provider: "${value}". Must be "gitlab" or "github".`);
}

export function normalizeProviderUrlInput(value: string): string {
  const url = value.trim();
  if (!url) return '';

  try {
    new URL(url);
    return url;
  } catch {
    const hint = /^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(url) ? ` Include the scheme, for example "https://${url}".` : '';
    throw new ConfigError(
      `Invalid provider URL: "${value}". Expected an absolute URL like "https://gitlab.com".${hint}`,
    );
  }
}

export function inferProviderFromUrl(value: string): ProviderType | null {
  const host = parseProviderUrlHost(value);
  if (!host) return null;
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
  return (provider === 'github' && host === 'github.com') || (provider === 'gitlab' && host === 'gitlab.com');
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
