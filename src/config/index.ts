import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { configSchema, type AppConfig } from '../core/schemas.js';
import { ConfigError } from '../core/errors.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'revkit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Default configuration. */
const DEFAULTS: Partial<AppConfig> = {
  provider: 'gitlab',
};

/**
 * Load config from ~/.config/revkit/config.json,
 * merging with environment variables and defaults.
 */
export async function loadConfig(): Promise<AppConfig> {
  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`Failed to load configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    // Environment variables take precedence
    ...(process.env.REVKIT_PROVIDER && { provider: process.env.REVKIT_PROVIDER }),
    ...(process.env.REVKIT_GITLAB_URL && { gitlabUrl: process.env.REVKIT_GITLAB_URL }),
    ...(process.env.REVKIT_GITLAB_TOKEN && { gitlabToken: process.env.REVKIT_GITLAB_TOKEN }),
    ...(process.env.GITLAB_TOKEN && !fileConfig.gitlabToken && !process.env.REVKIT_GITLAB_TOKEN && { gitlabToken: process.env.GITLAB_TOKEN }),
    ...(process.env.REVKIT_GITHUB_TOKEN && { githubToken: process.env.REVKIT_GITHUB_TOKEN }),
    ...(process.env.GITHUB_TOKEN && !fileConfig.githubToken && !process.env.REVKIT_GITHUB_TOKEN && { githubToken: process.env.GITHUB_TOKEN }),
    ...(process.env.REVKIT_REPO && { defaultRepository: process.env.REVKIT_REPO }),
    ...(process.env.REVKIT_CA_FILE && { caFile: process.env.REVKIT_CA_FILE }),
    ...(process.env.REVKIT_TLS_VERIFY && { tlsVerify: parseBooleanEnv('REVKIT_TLS_VERIFY', process.env.REVKIT_TLS_VERIFY) }),
  };

  const result = configSchema.safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  return result.data;
}

/**
 * Save config to disk.
 */
export async function saveConfig(config: Partial<AppConfig>): Promise<void> {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  let existing: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    existing = JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new ConfigError(`Failed to load existing configuration from ${CONFIG_FILE}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const merged = { ...existing, ...config };
  const result = configSchema.partial().safeParse(merged);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }

  await fs.writeFile(CONFIG_FILE, JSON.stringify(result.data, null, 2), 'utf-8');
}

function parseBooleanEnv(name: string, value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new ConfigError(`${name} must be one of: true, false, 1, 0, yes, no, on, off`);
}

export { CONFIG_FILE };
