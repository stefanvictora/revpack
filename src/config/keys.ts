import { ConfigError } from '../core/errors.js';
import type { ProviderType } from './types.js';

// ─── Parsers ─────────────────────────────────────────────

function parseProvider(value: string): ProviderType {
  if (value === 'gitlab' || value === 'github') return value;
  throw new ConfigError(`Invalid provider: "${value}". Must be "gitlab" or "github".`);
}

function parseUrl(value: string): string {
  try {
    new URL(value);
  } catch {
    throw new ConfigError(`Invalid URL: "${value}"`);
  }
  return value;
}

function parseEnvVarName(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new ConfigError(`Invalid environment variable name: "${value}"`);
  }
  return value;
}

function parseMatchPatterns(value: string): string[] {
  return value
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function parseString(value: string): string {
  return value;
}

function parseBoolean(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`Invalid boolean: "${value}". Use true/false, yes/no, 1/0, on/off.`);
}

// ─── Registry ────────────────────────────────────────────

export interface ConfigKeyDef {
  description: string;
  parse: (value: string) => unknown;
  isArray?: boolean;
}

export const CONFIG_KEYS: Record<string, ConfigKeyDef> = {
  provider: {
    description: 'Provider type (gitlab or github)',
    parse: parseProvider,
  },
  url: {
    description: 'Provider base URL',
    parse: parseUrl,
  },
  tokenEnv: {
    description: 'Environment variable containing the access token',
    parse: parseEnvVarName,
  },
  remotePatterns: {
    description: 'Additional git remote URL match patterns (comma-separated)',
    parse: parseMatchPatterns,
    isArray: true,
  },
  caFile: {
    description: 'Path to a custom CA certificate file',
    parse: parseString,
  },
  tlsVerify: {
    description: 'Whether to verify TLS certificates (true/false)',
    parse: parseBoolean,
  },
  sshClone: {
    description: 'Use SSH instead of HTTPS for git clone (true/false)',
    parse: parseBoolean,
  },
};

export const VALID_CONFIG_KEYS = Object.keys(CONFIG_KEYS);
