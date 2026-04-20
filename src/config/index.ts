import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { configSchema, type AppConfig } from '../core/schemas.js';
import { ConfigError } from '../core/errors.js';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'review-assist');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Default configuration. */
const DEFAULTS: Partial<AppConfig> = {
  provider: 'gitlab',
  bundleDir: '.review-assist',
};

/**
 * Load config from ~/.config/review-assist/config.json,
 * merging with environment variables and defaults.
 */
export async function loadConfig(): Promise<AppConfig> {
  let fileConfig: Record<string, unknown> = {};
  try {
    const raw = await fs.readFile(CONFIG_FILE, 'utf-8');
    fileConfig = JSON.parse(raw);
  } catch {
    // No config file — rely on env vars
  }

  const merged = {
    ...DEFAULTS,
    ...fileConfig,
    // Environment variables take precedence
    ...(process.env.REVIEW_ASSIST_PROVIDER && { provider: process.env.REVIEW_ASSIST_PROVIDER }),
    ...(process.env.REVIEW_ASSIST_GITLAB_URL && { gitlabUrl: process.env.REVIEW_ASSIST_GITLAB_URL }),
    ...(process.env.REVIEW_ASSIST_GITLAB_TOKEN && { gitlabToken: process.env.REVIEW_ASSIST_GITLAB_TOKEN }),
    ...(process.env.GITLAB_TOKEN && !fileConfig.gitlabToken && !process.env.REVIEW_ASSIST_GITLAB_TOKEN && { gitlabToken: process.env.GITLAB_TOKEN }),
    ...(process.env.REVIEW_ASSIST_GITHUB_TOKEN && { githubToken: process.env.REVIEW_ASSIST_GITHUB_TOKEN }),
    ...(process.env.GITHUB_TOKEN && !fileConfig.githubToken && !process.env.REVIEW_ASSIST_GITHUB_TOKEN && { githubToken: process.env.GITHUB_TOKEN }),
    ...(process.env.REVIEW_ASSIST_REPO && { defaultRepository: process.env.REVIEW_ASSIST_REPO }),
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
  } catch {
    // fresh
  }

  const merged = { ...existing, ...config };
  await fs.writeFile(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
}

export { CONFIG_FILE };
