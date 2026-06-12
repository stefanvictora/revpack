import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { WorkspaceError } from '../core/errors.js';
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

const { createOrchestrator, handleError } = await import('./helpers.js');

describe('cli helpers', () => {
  let tmpDir: string;
  let cwdSpy: MockInstance<() => string>;
  let exitSpy: MockInstance<typeof process.exit>;
  let consoleErrorSpy: MockInstance<typeof console.error>;
  let debugEnv: string | undefined;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-helpers-'));
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit: 1');
    });
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    debugEnv = process.env.DEBUG;
  });

  afterEach(async () => {
    if (debugEnv === undefined) {
      delete process.env.DEBUG;
    } else {
      process.env.DEBUG = debugEnv;
    }
    consoleErrorSpy.mockRestore();
    exitSpy.mockRestore();
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

  it('prints the user-facing error message and debug hint without DEBUG', () => {
    delete process.env.DEBUG;

    expect(() => handleError(new WorkspaceError('Cannot prepare bundle'))).toThrow('process.exit: 1');

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('[WORKSPACE_ERROR] Cannot prepare bundle'));
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Set DEBUG=1 for full stack trace'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('prints debug stack frames without repeating the error message', () => {
    process.env.DEBUG = '1';
    const err = new Error('Cannot prepare bundle\n\nPush your commits, then run revpack prepare');
    err.stack = [
      'Error: Cannot prepare bundle',
      '',
      'Push your commits, then run revpack prepare',
      '    at ReviewOrchestrator.prepare (orchestrator.js:126:23)',
      '    at async Command.<anonymous> (prepare.js:20:28)',
    ].join('\n');

    expect(() => handleError(err)).toThrow('process.exit: 1');

    const output = consoleErrorSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output.match(/Cannot prepare bundle/g)).toHaveLength(1);
    expect(output).toContain('Stack trace:');
    expect(output).toContain('    at ReviewOrchestrator.prepare (orchestrator.js:126:23)');
    expect(output).toContain('    at async Command.<anonymous> (prepare.js:20:28)');
  });
});
