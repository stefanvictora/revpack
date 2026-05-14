import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { ReviewProvider } from '../providers/provider.js';

vi.mock('../config/index.js', () => ({
  loadRuntimeConfig: vi.fn().mockResolvedValue({
    provider: 'github',
    token: 'token',
    tlsVerify: true,
  }),
}));

vi.mock('../providers/factory.js', () => ({
  createProvider: vi.fn().mockReturnValue({
    providerType: 'github',
  }),
}));

const { createOrchestrator } = await import('./helpers.js');

describe('cli helpers', () => {
  let tmpDir: string;
  let cwdSpy: MockInstance<[], string>;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-helpers-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  });

  afterEach(async () => {
    cwdSpy.mockRestore();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('uses an active local bundle by default but allows explicit callers to disable it', async () => {
    await fs.mkdir(path.join(tmpDir, '.revpack'), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, '.revpack', 'bundle.json'),
      JSON.stringify({
        target: {
          provider: 'local',
        },
      }),
      'utf-8',
    );

    const implicit = await createOrchestrator();
    expect((implicit as unknown as { provider: ReviewProvider }).provider.providerType).toBe('local');

    const explicit = await createOrchestrator(undefined, undefined, { allowActiveLocal: false });
    expect((explicit as unknown as { provider: ReviewProvider }).provider.providerType).toBe('github');
  });
});
