import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { configSchema } from '../core/schemas.js';
import { ConfigError } from '../core/errors.js';
import type {
  AppConfig,
  ResolvedAppConfig,
  DisplayAppConfig,
  DisplayTokenInfo,
  TokenSource,
  RevkitProfile,
} from './types.js';
import { SecretResolver } from './secret-resolver.js';
import { ProfileResolver } from './profile-resolver.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'revkit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/**
 * Load raw file config from ~/.config/revkit/config.json.
 */
export async function loadFileConfig(): Promise<AppConfig> {
  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    fileConfig = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(
        `Failed to load configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Apply env overrides for flat config
  const merged = {
    ...fileConfig,
    ...(process.env.REVKIT_PROVIDER && { provider: process.env.REVKIT_PROVIDER }),
    ...(process.env.REVKIT_GITLAB_URL && { gitlabUrl: process.env.REVKIT_GITLAB_URL }),
    ...(process.env.REVKIT_REPO && { defaultRepository: process.env.REVKIT_REPO }),
    ...(process.env.REVKIT_CA_FILE && { caFile: process.env.REVKIT_CA_FILE }),
    ...(process.env.REVKIT_TLS_VERIFY && {
      tlsVerify: parseBooleanEnv('REVKIT_TLS_VERIFY', process.env.REVKIT_TLS_VERIFY),
    }),
  };

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  return result.data as AppConfig;
}

/**
 * Resolve the active profile and return a fully resolved runtime config.
 * Resolves secrets from token sources.
 */
export async function loadRuntimeConfig(
  remoteUrls: string[] = [],
  explicitProfile?: string,
): Promise<ResolvedAppConfig> {
  const fileConfig = await loadFileConfig();
  const profileResolver = new ProfileResolver();
  const secretResolver = new SecretResolver();

  const { profile } = profileResolver.resolve(fileConfig, remoteUrls, explicitProfile);

  const resolved: ResolvedAppConfig = {
    provider: profile.provider,
    gitlabUrl: profile.gitlabUrl,
    defaultRepository: profile.defaultRepository,
    caFile: profile.caFile,
    tlsVerify: profile.tlsVerify ?? fileConfig.tlsVerify ?? true,
  };

  // Resolve GitLab token
  if (profile.gitlabTokenSource) {
    const secret = await secretResolver.resolve(profile.gitlabTokenSource);
    if (secret.value) {
      resolved.gitlabToken = secret.value;
    }
  }
  // Env fallbacks for GitLab token
  if (!resolved.gitlabToken && process.env.REVKIT_GITLAB_TOKEN) {
    resolved.gitlabToken = process.env.REVKIT_GITLAB_TOKEN;
  }
  if (!resolved.gitlabToken && process.env.GITLAB_TOKEN) {
    resolved.gitlabToken = process.env.GITLAB_TOKEN;
  }

  // Resolve GitHub token
  if (profile.githubTokenSource) {
    const secret = await secretResolver.resolve(profile.githubTokenSource);
    if (secret.value) {
      resolved.githubToken = secret.value;
    }
  }
  if (!resolved.githubToken && process.env.REVKIT_GITHUB_TOKEN) {
    resolved.githubToken = process.env.REVKIT_GITHUB_TOKEN;
  }
  if (!resolved.githubToken && process.env.GITHUB_TOKEN) {
    resolved.githubToken = process.env.GITHUB_TOKEN;
  }

  return resolved;
}

/**
 * Load a safe display config (no secrets exposed).
 */
export async function loadDisplayConfig(
  remoteUrls: string[] = [],
  explicitProfile?: string,
): Promise<DisplayAppConfig> {
  const fileConfig = await loadFileConfig();
  const profileResolver = new ProfileResolver();
  const secretResolver = new SecretResolver();

  let profile: RevkitProfile;
  let profileName: string | null = null;
  try {
    const result = profileResolver.resolve(fileConfig, remoteUrls, explicitProfile);
    profile = result.profile;
    profileName = result.profileName;
  } catch {
    // If profile resolution fails, show what we can from root config
    return buildFallbackDisplayConfig(fileConfig, secretResolver);
  }

  const display: DisplayAppConfig = {
    provider: profile.provider,
    activeProfile: profileName ?? undefined,
    gitlabUrl: profile.gitlabUrl,
    defaultRepository: profile.defaultRepository,
    caFile: profile.caFile,
    tlsVerify: profile.tlsVerify ?? fileConfig.tlsVerify ?? true,
  };

  if (profile.gitlabTokenSource) {
    display.gitlabTokenSource = await buildDisplayTokenInfo(profile.gitlabTokenSource, secretResolver);
  }

  if (profile.githubTokenSource) {
    display.githubTokenSource = await buildDisplayTokenInfo(profile.githubTokenSource, secretResolver);
  }

  return display;
}

async function buildFallbackDisplayConfig(
  config: AppConfig,
  secretResolver: SecretResolver,
): Promise<DisplayAppConfig> {
  const display: DisplayAppConfig = {
    provider: config.provider,
    gitlabUrl: config.gitlabUrl,
    defaultRepository: config.defaultRepository,
    caFile: config.caFile,
    tlsVerify: config.tlsVerify ?? true,
  };

  if (config.gitlabTokenSource) {
    display.gitlabTokenSource = await buildDisplayTokenInfo(config.gitlabTokenSource, secretResolver);
  }
  if (config.githubTokenSource) {
    display.githubTokenSource = await buildDisplayTokenInfo(config.githubTokenSource, secretResolver);
  }

  return display;
}

async function buildDisplayTokenInfo(
  source: TokenSource,
  secretResolver: SecretResolver,
): Promise<DisplayTokenInfo> {
  const resolved = await secretResolver.isResolved(source);
  return {
    type: source.type,
    name: source.name,
    resolved,
  };
}

/**
 * Legacy loadConfig for backwards compatibility during migration.
 * Uses loadRuntimeConfig internally.
 */
export async function loadConfig(remoteUrls: string[] = []): Promise<ResolvedAppConfig> {
  return loadRuntimeConfig(remoteUrls);
}

/**
 * Save config to disk.
 */
export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(
        `Failed to load existing configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const merged = { ...existing, ...config };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

/**
 * Unset a config key from disk.
 */
export async function unsetConfig(key: string): Promise<boolean> {
  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(
        `Failed to load existing configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return false;
  }

  // Support dotted keys for nested values
  const parts = key.split('.');
  if (parts.length === 1) {
    if (!(key in existing)) return false;
    delete existing[key];
  } else {
    let obj: Record<string, unknown> = existing;
    for (let i = 0; i < parts.length - 1; i++) {
      const next = obj[parts[i]];
      if (!next || typeof next !== 'object') return false;
      obj = next as Record<string, unknown>;
    }
    const lastKey = parts[parts.length - 1];
    if (!(lastKey in obj)) return false;
    delete obj[lastKey];
  }

  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(existing, null, 2), 'utf-8');
  return true;
}

/**
 * Save raw JSON to config (bypasses schema validation for nested objects).
 */
export async function saveRawConfig(data: Record<string, unknown>): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(
        `Failed to load existing configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const merged = deepMerge(existing, data);
  await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (srcVal && typeof srcVal === 'object' && !Array.isArray(srcVal) && tgtVal && typeof tgtVal === 'object' && !Array.isArray(tgtVal)) {
      result[key] = deepMerge(tgtVal as Record<string, unknown>, srcVal as Record<string, unknown>);
    } else {
      result[key] = srcVal;
    }
  }
  return result;
}

function parseBooleanEnv(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

export { CONFIG_DIR, CONFIG_FILE };
export { SecretResolver } from './secret-resolver.js';
export { ProfileResolver } from './profile-resolver.js';
export type {
  AppConfig,
  ResolvedAppConfig,
  DisplayAppConfig,
  TokenSource,
  RevkitProfile,
} from './types.js';
