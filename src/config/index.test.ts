import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

// We mock fs so nothing touches the real filesystem
vi.mock('node:fs/promises');

const CONFIG_DIR = path.join(os.homedir(), '.config', 'revkit');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Dynamic import after mocking
const { loadFileConfig, loadRuntimeConfig, loadDisplayConfig, saveConfig, unsetConfig, saveRawConfig } =
  await import('./index.js');

// Helper: make readFile return a JSON config
function mockConfigFile(config: Record<string, unknown>): void {
  vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(config));
}

// Helper: make readFile throw ENOENT (no config file)
function mockNoConfigFile(): void {
  const err = new Error('ENOENT') as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  vi.mocked(fs.readFile).mockRejectedValue(err);
}

// Env snapshot and cleanup
const originalEnv = { ...process.env };

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fs.mkdir).mockResolvedValue(undefined);
  vi.mocked(fs.writeFile).mockResolvedValue(undefined);

  // Clear relevant env vars
  delete process.env.REVKIT_PROVIDER;
  delete process.env.REVKIT_GITLAB_URL;
  delete process.env.REVKIT_REPO;
  delete process.env.REVKIT_CA_FILE;
  delete process.env.REVKIT_TLS_VERIFY;
  delete process.env.REVKIT_GITLAB_TOKEN;
  delete process.env.GITLAB_TOKEN;
  delete process.env.REVKIT_GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// ─── loadFileConfig ──────────────────────────────────────

describe('loadFileConfig', () => {
  it('returns empty defaults when no config file exists', async () => {
    mockNoConfigFile();
    const config = await loadFileConfig();
    expect(config).toEqual({ tlsVerify: true });
  });

  it('loads a flat config from file', async () => {
    mockConfigFile({
      provider: 'gitlab',
      gitlabUrl: 'https://gitlab.example.com',
      defaultRepository: 'group/project',
    });

    const config = await loadFileConfig();
    expect(config.provider).toBe('gitlab');
    expect(config.gitlabUrl).toBe('https://gitlab.example.com');
    expect(config.defaultRepository).toBe('group/project');
  });

  it('loads a profile-based config from file', async () => {
    mockConfigFile({
      defaultProfile: 'work',
      profiles: {
        work: {
          provider: 'gitlab',
          gitlabUrl: 'https://gitlab.work.com',
          gitlabTokenSource: { type: 'env', name: 'WORK_TOKEN' },
          remoteUrlPatterns: ['gitlab.work.com'],
        },
      },
    });

    const config = await loadFileConfig();
    expect(config.defaultProfile).toBe('work');
    expect(config.profiles?.work?.provider).toBe('gitlab');
    expect(config.profiles?.work?.gitlabTokenSource).toEqual({ type: 'env', name: 'WORK_TOKEN' });
  });

  it('applies REVKIT_PROVIDER env override', async () => {
    mockConfigFile({ provider: 'gitlab' });
    process.env.REVKIT_PROVIDER = 'github';

    const config = await loadFileConfig();
    expect(config.provider).toBe('github');
  });

  it('applies REVKIT_GITLAB_URL env override', async () => {
    mockConfigFile({});
    process.env.REVKIT_GITLAB_URL = 'https://override.example.com';

    const config = await loadFileConfig();
    expect(config.gitlabUrl).toBe('https://override.example.com');
  });

  it('applies REVKIT_TLS_VERIFY env override', async () => {
    mockConfigFile({});
    process.env.REVKIT_TLS_VERIFY = 'false';

    const config = await loadFileConfig();
    expect(config.tlsVerify).toBe(false);
  });

  it('throws on invalid REVKIT_TLS_VERIFY value', async () => {
    mockConfigFile({});
    process.env.REVKIT_TLS_VERIFY = 'maybe';

    await expect(loadFileConfig()).rejects.toThrow('must be one of');
  });

  it('throws on invalid JSON in config file', async () => {
    vi.mocked(fs.readFile).mockResolvedValue('not-json');
    await expect(loadFileConfig()).rejects.toThrow();
  });

  it('throws on non-ENOENT read errors', async () => {
    const err = new Error('EACCES') as NodeJS.ErrnoException;
    err.code = 'EACCES';
    vi.mocked(fs.readFile).mockRejectedValue(err);

    await expect(loadFileConfig()).rejects.toThrow('Failed to load configuration');
  });
});

// ─── loadRuntimeConfig ───────────────────────────────────

describe('loadRuntimeConfig', () => {
  it('resolves flat config with env token fallback', async () => {
    mockConfigFile({ provider: 'gitlab', gitlabUrl: 'https://gl.example.com' });
    process.env.REVKIT_GITLAB_TOKEN = 'my-secret-token';

    const config = await loadRuntimeConfig();
    expect(config.provider).toBe('gitlab');
    expect(config.gitlabUrl).toBe('https://gl.example.com');
    expect(config.gitlabToken).toBe('my-secret-token');
    expect(config.tlsVerify).toBe(true);
  });

  it('resolves profile by explicit name', async () => {
    mockConfigFile({
      profiles: {
        customer: {
          provider: 'gitlab',
          gitlabUrl: 'https://customer.gitlab.com',
          gitlabTokenSource: { type: 'env', name: 'CUSTOMER_TOKEN' },
        },
      },
    });
    process.env.CUSTOMER_TOKEN = 'cust-secret';

    const config = await loadRuntimeConfig([], 'customer');
    expect(config.provider).toBe('gitlab');
    expect(config.gitlabUrl).toBe('https://customer.gitlab.com');
    expect(config.gitlabToken).toBe('cust-secret');
  });

  it('resolves profile by remote URL pattern match', async () => {
    mockConfigFile({
      profiles: {
        work: {
          provider: 'gitlab',
          gitlabUrl: 'https://work.gitlab.com',
          remoteUrlPatterns: ['work.gitlab.com'],
        },
        personal: {
          provider: 'github',
          remoteUrlPatterns: ['github.com'],
        },
      },
    });

    const config = await loadRuntimeConfig(['git@work.gitlab.com:team/repo.git']);
    expect(config.provider).toBe('gitlab');
    expect(config.gitlabUrl).toBe('https://work.gitlab.com');
  });

  it('falls back to GITLAB_TOKEN when no tokenSource and no REVKIT_GITLAB_TOKEN', async () => {
    mockConfigFile({ provider: 'gitlab' });
    process.env.GITLAB_TOKEN = 'fallback-token';

    const config = await loadRuntimeConfig();
    expect(config.gitlabToken).toBe('fallback-token');
  });

  it('resolves GitHub token from env', async () => {
    mockConfigFile({ provider: 'github' });
    process.env.REVKIT_GITHUB_TOKEN = 'gh-token';

    const config = await loadRuntimeConfig();
    expect(config.githubToken).toBe('gh-token');
  });

  it('falls back to GITHUB_TOKEN env var', async () => {
    mockConfigFile({ provider: 'github' });
    process.env.GITHUB_TOKEN = 'gh-fallback';

    const config = await loadRuntimeConfig();
    expect(config.githubToken).toBe('gh-fallback');
  });

  it('resolves token from profile tokenSource env var', async () => {
    mockConfigFile({
      profiles: {
        test: {
          provider: 'gitlab',
          gitlabTokenSource: { type: 'env', name: 'CUSTOM_GL_TOKEN' },
        },
      },
      defaultProfile: 'test',
    });
    process.env.CUSTOM_GL_TOKEN = 'custom-secret';

    const config = await loadRuntimeConfig();
    expect(config.gitlabToken).toBe('custom-secret');
  });

  it('sets tlsVerify from profile', async () => {
    mockConfigFile({
      profiles: {
        insecure: {
          provider: 'gitlab',
          tlsVerify: false,
        },
      },
      defaultProfile: 'insecure',
    });

    const config = await loadRuntimeConfig();
    expect(config.tlsVerify).toBe(false);
  });

  it('inherits tlsVerify from root config when profile does not set it', async () => {
    mockConfigFile({
      tlsVerify: false,
      profiles: {
        p: { provider: 'gitlab' },
      },
      defaultProfile: 'p',
    });

    const config = await loadRuntimeConfig();
    expect(config.tlsVerify).toBe(false);
  });
});

// ─── loadDisplayConfig ───────────────────────────────────

describe('loadDisplayConfig', () => {
  it('shows profile info without exposing secrets', async () => {
    mockConfigFile({
      profiles: {
        work: {
          provider: 'gitlab',
          gitlabUrl: 'https://work.gl.com',
          gitlabTokenSource: { type: 'env', name: 'WORK_TOKEN' },
        },
      },
      defaultProfile: 'work',
    });
    process.env.WORK_TOKEN = 'secret';

    const display = await loadDisplayConfig();
    expect(display.provider).toBe('gitlab');
    expect(display.activeProfile).toBe('work');
    expect(display.gitlabTokenSource).toEqual({
      type: 'env',
      name: 'WORK_TOKEN',
      resolved: true,
    });
    // No actual token value in display config
    expect(display).not.toHaveProperty('gitlabToken');
  });

  it('shows unresolved token when env var is not set', async () => {
    mockConfigFile({
      profiles: {
        work: {
          provider: 'gitlab',
          gitlabTokenSource: { type: 'env', name: 'MISSING_TOKEN' },
        },
      },
      defaultProfile: 'work',
    });

    const display = await loadDisplayConfig();
    expect(display.gitlabTokenSource).toEqual({
      type: 'env',
      name: 'MISSING_TOKEN',
      resolved: false,
    });
  });

  it('falls back to root config when profile resolution fails', async () => {
    mockConfigFile({
      provider: 'github',
      gitlabUrl: 'https://fallback.example.com',
    });

    const display = await loadDisplayConfig();
    expect(display.provider).toBe('github');
    expect(display.gitlabUrl).toBe('https://fallback.example.com');
    expect(display.activeProfile).toBeUndefined();
  });

  it('resolves specific profile with --profile', async () => {
    mockConfigFile({
      profiles: {
        alpha: { provider: 'gitlab', gitlabUrl: 'https://alpha.com' },
        beta: { provider: 'github' },
      },
      defaultProfile: 'beta',
    });

    const display = await loadDisplayConfig([], 'alpha');
    expect(display.activeProfile).toBe('alpha');
    expect(display.provider).toBe('gitlab');
    expect(display.gitlabUrl).toBe('https://alpha.com');
  });
});

// ─── saveConfig ──────────────────────────────────────────

describe('saveConfig', () => {
  it('creates directory and writes config when no existing file', async () => {
    mockNoConfigFile();

    await saveConfig({ provider: 'gitlab' });

    expect(fs.mkdir).toHaveBeenCalledWith(CONFIG_DIR, { recursive: true });
    expect(fs.writeFile).toHaveBeenCalledWith(
      CONFIG_FILE,
      expect.stringContaining('"provider": "gitlab"'),
      'utf-8',
    );
  });

  it('merges with existing config', async () => {
    mockConfigFile({ provider: 'gitlab', gitlabUrl: 'https://old.com' });

    await saveConfig({ gitlabUrl: 'https://new.com' });

    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.provider).toBe('gitlab');
    expect(parsed.gitlabUrl).toBe('https://new.com');
  });
});

// ─── unsetConfig ─────────────────────────────────────────

describe('unsetConfig', () => {
  it('removes a top-level key', async () => {
    mockConfigFile({ provider: 'gitlab', gitlabUrl: 'https://example.com' });

    const removed = await unsetConfig('gitlabUrl');
    expect(removed).toBe(true);

    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed).not.toHaveProperty('gitlabUrl');
    expect(parsed.provider).toBe('gitlab');
  });

  it('removes a nested key via dotted path', async () => {
    mockConfigFile({
      profiles: {
        work: { provider: 'gitlab', gitlabUrl: 'https://work.com' },
      },
    });

    const removed = await unsetConfig('profiles.work.gitlabUrl');
    expect(removed).toBe(true);

    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.profiles.work).not.toHaveProperty('gitlabUrl');
    expect(parsed.profiles.work.provider).toBe('gitlab');
  });

  it('returns false when key does not exist', async () => {
    mockConfigFile({ provider: 'gitlab' });

    const removed = await unsetConfig('nonExistent');
    expect(removed).toBe(false);
  });

  it('returns false when config file does not exist', async () => {
    mockNoConfigFile();

    const removed = await unsetConfig('anything');
    expect(removed).toBe(false);
  });
});

// ─── saveRawConfig ───────────────────────────────────────

describe('saveRawConfig', () => {
  it('deep-merges profiles into existing config', async () => {
    mockConfigFile({
      profiles: {
        existing: { provider: 'gitlab', gitlabUrl: 'https://existing.com' },
      },
    });

    await saveRawConfig({
      profiles: {
        newProfile: { provider: 'github' },
      },
    });

    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.profiles.existing.provider).toBe('gitlab');
    expect(parsed.profiles.newProfile.provider).toBe('github');
  });

  it('overwrites scalar values', async () => {
    mockConfigFile({ defaultProfile: 'old' });

    await saveRawConfig({ defaultProfile: 'new' });

    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.defaultProfile).toBe('new');
  });

  it('creates config file from scratch when none exists', async () => {
    mockNoConfigFile();

    await saveRawConfig({ profiles: { test: { provider: 'gitlab' } } });

    expect(fs.writeFile).toHaveBeenCalled();
    const written = vi.mocked(fs.writeFile).mock.calls[0][1] as string;
    const parsed = JSON.parse(written);
    expect(parsed.profiles.test.provider).toBe('gitlab');
  });
});
