import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewTarget, WorkspaceBundle } from '../../core/types.js';
import { registerCheckoutCommand } from './checkout.js';

const {
  checkoutMock,
  prepareMock,
  createOrchestratorMock,
  createOrchestratorAtMock,
  getRepoFromGitMock,
  runSetupMock,
} = vi.hoisted(() => ({
  checkoutMock: vi.fn(),
  prepareMock: vi.fn(),
  createOrchestratorMock: vi.fn(),
  createOrchestratorAtMock: vi.fn(),
  getRepoFromGitMock: vi.fn(),
  runSetupMock: vi.fn(),
}));

vi.mock('../helpers.js', () => ({
  createOrchestrator: createOrchestratorMock,
  createOrchestratorAt: createOrchestratorAtMock,
  getRepoFromGit: getRepoFromGitMock,
  handleError: vi.fn((err: unknown) => {
    throw err;
  }),
}));

vi.mock('./setup.js', () => ({
  runSetup: runSetupMock,
}));

describe('checkout command', () => {
  const target: ReviewTarget = {
    provider: 'github',
    repository: 'owner/repo',
    targetType: 'pull_request',
    targetId: '42',
    title: 'Improve checkout',
    description: '',
    author: 'octocat',
    state: 'opened',
    sourceBranch: 'feature',
    targetBranch: 'main',
    webUrl: 'https://example.com/pull/42',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    labels: [],
    diffRefs: {
      baseSha: 'base',
      headSha: 'head',
      startSha: 'start',
    },
  };

  const bundle: Pick<WorkspaceBundle, 'threads' | 'diffs'> = {
    threads: [],
    diffs: [],
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    checkoutMock.mockResolvedValue({ branch: 'feature', target });
    prepareMock.mockResolvedValue({ bundle, contextPath: '.revpack/CONTEXT.md' });
    createOrchestratorMock.mockResolvedValue({ checkout: checkoutMock, prepare: prepareMock });
    createOrchestratorAtMock.mockResolvedValue({ prepare: prepareMock });
    getRepoFromGitMock.mockResolvedValue('owner/repo');
    runSetupMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('prepares after checkout by default', async () => {
    await parseCheckout('!42');

    expect(checkoutMock).toHaveBeenCalledWith('!42', 'owner/repo');
    expect(prepareMock).toHaveBeenCalledWith(
      '!42',
      'owner/repo',
      expect.objectContaining({
        fresh: true,
        onProgress: expect.any(Function),
      }),
    );
    expect(runSetupMock).not.toHaveBeenCalled();
  });

  it('still runs setup after the default prepare when requested', async () => {
    await parseCheckout('!42', '--setup');

    expect(prepareMock).toHaveBeenCalled();
    expect(runSetupMock).toHaveBeenCalledWith({ cwd: process.cwd() });
  });

  it('shows concise target examples in help', async () => {
    const output: string[] = [];
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeOut: (value) => output.push(value),
      writeErr: (value) => output.push(value),
    });
    registerCheckoutCommand(program);

    try {
      await program.parseAsync(['node', 'revpack', 'checkout', '--help']);
    } catch {
      // Commander exits after printing --help when exitOverride is enabled.
    }

    const help = output.join('');
    expect(help).toContain('Examples:');
    expect(help).toContain('revpack checkout !42');
    expect(help).toContain('revpack checkout 58 --repo owner/repo');
    expect(help).toContain('revpack checkout https://github.com/owner/repo/pull/58');
    expect(help).toContain('revpack checkout workspace/repo#42 --profile bitbucket');
  });

  async function parseCheckout(...args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerCheckoutCommand(program);

    await program.parseAsync(['node', 'revpack', 'checkout', ...args]);
  }
});
