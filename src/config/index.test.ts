import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { resolveProfile, loadDisplayConfig, loadRuntimeConfig, runDoctor, loadFileConfig } from './index.js';
import type { RevpackConfig } from './types.js';

// Mock fs
vi.mock('node:fs/promises');

const mockFs = vi.mocked(fs);

function writeConfig(config: RevpackConfig): void {
  mockFs.readFile.mockResolvedValue(JSON.stringify(config));
}

describe('loadFileConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns empty config when file does not exist', async () => {
    mockFs.readFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await loadFileConfig();
    expect(result).toEqual({});
  });

  it('parses valid config', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com', tokenEnv: 'GL_TOKEN' },
      },
    };
    writeConfig(config);
    const result = await loadFileConfig();
    expect(result.profiles?.work?.provider).toBe('gitlab');
  });

  it('throws on invalid JSON', async () => {
    mockFs.readFile.mockResolvedValue('not json {{{');
    await expect(loadFileConfig()).rejects.toThrow(/not valid JSON/);
  });

  it('throws on invalid config structure', async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify({ profiles: { bad: { provider: 'bitbucket' } } }));
    await expect(loadFileConfig()).rejects.toThrow(/Invalid configuration/);
  });
});

describe('resolveProfile', () => {
  it('resolves by explicit name', () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
      },
    };
    const result = resolveProfile(config, [], 'work');
    expect(result.profileName).toBe('work');
    expect(result.matchedBy).toBe('explicit');
  });

  it('resolves by URL-derived remote match', () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
      },
    };
    const result = resolveProfile(config, ['git@gitlab.work.com:team/repo.git']);
    expect(result.profileName).toBe('work');
    expect(result.matchedBy).toBe('remote-match');
    expect(result.matchedPattern).toBe('gitlab.work.com');
    expect(result.matchSource).toBe('url-derived');
  });

  it('resolves by remotePatterns match', () => {
    const config: RevpackConfig = {
      profiles: {
        custom: { provider: 'github', remotePatterns: ['custom-host'] },
      },
    };
    const result = resolveProfile(config, ['git@custom-host:org/repo.git']);
    expect(result.matchedPattern).toBe('custom-host');
    expect(result.matchSource).toBe('remote-pattern');
  });

  it('explicit takes priority over remote-match', () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com' },
        oss: { provider: 'github', url: 'https://github.com' },
      },
    };
    const result = resolveProfile(config, ['git@gitlab.work.com:team/repo.git'], 'oss');
    expect(result.matchedBy).toBe('explicit');
    expect(result.profileName).toBe('oss');
  });

  it('throws when no match', () => {
    const config: RevpackConfig = {
      profiles: { work: { provider: 'gitlab', url: 'https://gitlab.work.com' } },
    };
    expect(() => resolveProfile(config, ['git@other.com:team/repo.git'])).toThrow(/No profile matched/);
  });

  it('throws for explicit profile that does not exist', () => {
    const config: RevpackConfig = {
      profiles: { work: { provider: 'gitlab' } },
    };
    expect(() => resolveProfile(config, [], 'missing')).toThrow(/not found/);
  });
});

describe('loadRuntimeConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.TEST_TOKEN;
  });

  it('resolves profile and token', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          tokenEnv: 'TEST_TOKEN',
        },
      },
    };
    writeConfig(config);
    process.env.TEST_TOKEN = 'secret123';

    const result = await loadRuntimeConfig(['git@gitlab.work.com:team/repo.git']);
    expect(result.provider).toBe('gitlab');
    expect(result.url).toBe('https://gitlab.work.com');
    expect(result.token).toBe('secret123');
    expect(result.tlsVerify).toBe(true);
  });

  it('handles missing token env gracefully', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com', tokenEnv: 'TEST_TOKEN' },
      },
    };
    writeConfig(config);
    delete process.env.TEST_TOKEN;

    const result = await loadRuntimeConfig(['git@gitlab.work.com:t/r.git']);
    expect(result.token).toBeUndefined();
  });

  it('respects tlsVerify false', async () => {
    const config: RevpackConfig = {
      profiles: {
        insecure: { provider: 'gitlab', tlsVerify: false, remotePatterns: ['insecure.com'] },
      },
    };
    writeConfig(config);
    const result = await loadRuntimeConfig(['git@insecure.com:t/r.git']);
    expect(result.tlsVerify).toBe(false);
  });
});

describe('loadDisplayConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.TEST_TOKEN;
  });

  it('includes match information for remote-match', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          tokenEnv: 'TEST_TOKEN',
        },
      },
    };
    writeConfig(config);
    process.env.TEST_TOKEN = 'x';

    const display = await loadDisplayConfig(['git@gitlab.work.com:team/repo.git']);
    expect(display.profileName).toBe('work');
    expect(display.matchedBy).toBe('remote-match');
    expect(display.matchedPattern).toBe('gitlab.work.com');
    expect(display.matchSource).toBe('url-derived');
    expect(display.tokenResolved).toBe(true);
  });

  it('includes explicit match info', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          tokenEnv: 'TEST_TOKEN',
          remotePatterns: ['example.com'],
        },
      },
    };
    writeConfig(config);

    const display = await loadDisplayConfig([], 'work');
    expect(display.matchedBy).toBe('explicit');
    expect(display.matchedPattern).toBeUndefined();
  });
});

describe('runDoctor', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    delete process.env.DOC_TOKEN;
  });

  it('reports healthy config', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          tokenEnv: 'DOC_TOKEN',
        },
      },
    };
    writeConfig(config);
    process.env.DOC_TOKEN = 'val';
    mockFs.access.mockResolvedValue(undefined);

    const result = await runDoctor(['git@gitlab.work.com:t/r.git']);
    expect(result.profileName).toBe('work');
    const failingChecks = result.checks.filter((c) => !c.ok);
    expect(failingChecks).toHaveLength(0);
  });

  it('reports when token env is not set', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: {
          provider: 'gitlab',
          url: 'https://gitlab.work.com',
          tokenEnv: 'DOC_TOKEN',
        },
      },
    };
    writeConfig(config);
    delete process.env.DOC_TOKEN;

    const result = await runDoctor(['git@gitlab.work.com:t/r.git']);
    const tokenCheck = result.checks.find((c) => c.label.includes('Token env is not set'));
    expect(tokenCheck).toBeDefined();
    expect(tokenCheck!.ok).toBe(false);
  });

  it('reports when no profile matches', async () => {
    const config: RevpackConfig = {
      profiles: {
        work: { provider: 'gitlab', url: 'https://gitlab.work.com', tokenEnv: 'DOC_TOKEN' },
      },
    };
    writeConfig(config);
    process.env.DOC_TOKEN = 'x';

    const result = await runDoctor(['git@other.com:t/r.git']);
    const noMatch = result.checks.find((c) => c.label.includes('Profile resolution'));
    expect(noMatch).toBeDefined();
    expect(noMatch!.ok).toBe(false);
  });
});
