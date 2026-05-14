import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { configSchema } from '../core/schemas.js';
import { ConfigError } from '../core/errors.js';
import type {
  RevpackConfig,
  RevpackProfile,
  ResolvedAppConfig,
  DisplayAppConfig,
  ProfileResolutionResult,
  DoctorCheck,
  DoctorResult,
} from './types.js';
import { ProfileResolver, getProfileRemotePatterns } from './profile-resolver.js';

export const CONFIG_DIR = path.join(os.homedir(), '.config', 'revpack');
export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ─── File I/O ────────────────────────────────────────────

/**
 * Load raw config from ~/.config/revpack/config.json.
 */
export async function loadFileConfig(): Promise<RevpackConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(CONFIG_FILE, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new ConfigError(
      `Failed to read config from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${CONFIG_FILE}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  return result.data;
}

/**
 * Write a full config object to disk (explicit read-modify-write).
 */
export async function saveFileConfig(config: RevpackConfig): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// ─── Profile Resolution ──────────────────────────────────

/**
 * Resolve the active profile. Throws if no profile matches.
 */
export function resolveProfile(
  config: RevpackConfig,
  remoteUrls: string[],
  explicitProfile?: string,
): ProfileResolutionResult {
  const resolver = new ProfileResolver();
  return resolver.resolve(config, remoteUrls, explicitProfile);
}

// ─── Runtime Config ──────────────────────────────────────

/**
 * Load config, resolve profile, resolve token → ready for use.
 */
export async function loadRuntimeConfig(
  remoteUrls: string[] = [],
  explicitProfile?: string,
): Promise<ResolvedAppConfig> {
  const fileConfig = await loadFileConfig();
  const { profile } = resolveProfile(fileConfig, remoteUrls, explicitProfile);

  const resolved: ResolvedAppConfig = {
    provider: profile.provider,
    url: profile.url,
    caFile: profile.caFile,
    tlsVerify: profile.tlsVerify ?? true,
    sshClone: profile.sshClone,
  };

  // Resolve token from configured env var
  if (profile.tokenEnv) {
    const value = process.env[profile.tokenEnv];
    if (value && value.length > 0) {
      resolved.token = value;
    }
  }

  return resolved;
}

// ─── Display Config ──────────────────────────────────────

/**
 * Load config for display (no secrets exposed).
 */
export async function loadDisplayConfig(remoteUrls: string[], explicitProfile?: string): Promise<DisplayAppConfig> {
  const fileConfig = await loadFileConfig();
  const { profile, profileName, matchedBy, matchedPattern, matchSource } = resolveProfile(
    fileConfig,
    remoteUrls,
    explicitProfile,
  );

  const tokenResolved = profile.tokenEnv
    ? Boolean(process.env[profile.tokenEnv] && process.env[profile.tokenEnv]!.length > 0)
    : false;

  return {
    profileName,
    matchedBy,
    matchedPattern,
    matchSource,
    provider: profile.provider,
    url: profile.url,
    tokenEnv: profile.tokenEnv,
    tokenResolved,
    caFile: profile.caFile,
    tlsVerify: profile.tlsVerify ?? true,
    sshClone: profile.sshClone ?? false,
  };
}

// ─── Doctor ──────────────────────────────────────────────

/**
 * Run local config health checks.
 */
export async function runDoctor(remoteUrls: string[], explicitProfile?: string): Promise<DoctorResult> {
  const checks: DoctorCheck[] = [];
  const nextSteps: string[] = [];
  let profileName: string | undefined;

  // 1. Config file readable
  let fileConfig: RevpackConfig;
  try {
    fileConfig = await loadFileConfig();
    checks.push({ ok: true, label: 'Config file readable' });
  } catch (err) {
    checks.push({ ok: false, label: 'Config file readable', detail: (err as Error).message });
    nextSteps.push(`Fix or recreate ${CONFIG_FILE}`);
    return { checks, nextSteps };
  }

  // 2. Profile resolution
  let profile: RevpackProfile;
  try {
    const result = resolveProfile(fileConfig, remoteUrls, explicitProfile);
    profile = result.profile;
    profileName = result.profileName;
    checks.push({ ok: true, label: `Profile: ${profileName}` });
  } catch (err) {
    checks.push({ ok: false, label: 'Profile resolution', detail: (err as Error).message });
    nextSteps.push('revpack config setup');
    return { checks, profileName, nextSteps };
  }

  // 3. Provider is valid
  if (['gitlab', 'github'].includes(profile.provider)) {
    checks.push({ ok: true, label: `Provider: ${profile.provider}` });
  } else {
    checks.push({ ok: false, label: 'Provider', detail: `Invalid provider: ${profile.provider}` });
  }

  // 4. URL
  if (profile.url) {
    try {
      new URL(profile.url);
      checks.push({ ok: true, label: `URL: ${profile.url}` });
    } catch {
      checks.push({ ok: false, label: 'URL', detail: `Invalid URL: ${profile.url}` });
    }
  }

  // 5. Token env configured
  if (profile.tokenEnv) {
    checks.push({ ok: true, label: `Token env configured: ${profile.tokenEnv}` });

    // 6. Token env is set
    const value = process.env[profile.tokenEnv];
    if (value && value.length > 0) {
      checks.push({ ok: true, label: 'Token env is set' });
    } else {
      checks.push({ ok: false, label: 'Token env is not set' });
      nextSteps.push(`export ${profile.tokenEnv}=...`);
    }
  } else {
    checks.push({ ok: false, label: 'Token env not configured' });
    nextSteps.push(`revpack config set tokenEnv <ENV_VAR_NAME> --profile ${profileName}`);
  }

  // 7. CA file
  if (profile.caFile) {
    try {
      await fs.access(profile.caFile);
      checks.push({ ok: true, label: `CA file exists: ${profile.caFile}` });
    } catch {
      checks.push({ ok: false, label: 'CA file', detail: `Not found: ${profile.caFile}` });
    }
  }

  // 8. TLS verify
  if (profile.tlsVerify === false) {
    checks.push({ ok: true, label: 'TLS verification disabled (warning)' });
  } else {
    checks.push({ ok: true, label: 'TLS verification enabled' });
  }

  // 9. Remote match (only when not using explicit profile)
  if (remoteUrls.length > 0 && !explicitProfile) {
    const profiles = fileConfig.profiles ?? {};
    const matchingNames: string[] = [];
    for (const [name, p] of Object.entries(profiles)) {
      const candidates = getProfileRemotePatterns(p);
      if (candidates.some(({ pattern }) => remoteUrls.some((url) => url.includes(pattern)))) {
        matchingNames.push(name);
      }
    }
    if (matchingNames.length === 1) {
      checks.push({ ok: true, label: 'Current git remote matches profile' });
    } else if (matchingNames.length === 0) {
      checks.push({ ok: false, label: 'No profile matches current git remotes' });
      nextSteps.push(`revpack config set remotePatterns <pattern> --profile ${profileName}`);
    } else {
      checks.push({
        ok: false,
        label: 'Ambiguous match',
        detail: `Multiple profiles match: ${matchingNames.join(', ')}`,
      });
    }
  }

  return { checks, profileName, nextSteps };
}

// ─── Re-exports ──────────────────────────────────────────

export { ProfileResolver, getProfileRemotePatterns } from './profile-resolver.js';
export type {
  RevpackConfig,
  RevpackProfile,
  ResolvedAppConfig,
  DisplayAppConfig,
  ProfileResolutionResult,
  ProviderType,
  DoctorCheck,
  DoctorResult,
} from './types.js';
