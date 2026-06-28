import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewTarget, WorkspaceBundle } from '../../core/types.js';
import { registerPrepareCommand } from './prepare.js';

const { prepareMock, createOrchestratorMock, getRepoFromGitMock, getTargetStateColorMock } = vi.hoisted(() => ({
  prepareMock: vi.fn(),
  createOrchestratorMock: vi.fn(),
  getRepoFromGitMock: vi.fn(),
  getTargetStateColorMock: vi.fn(),
}));

vi.mock('../helpers.js', () => ({
  createLocalOrchestrator: vi.fn(),
  createOrchestrator: createOrchestratorMock,
  getRepoFromGit: getRepoFromGitMock,
  handleError: vi.fn((err: unknown) => {
    throw err;
  }),
  outputJson: vi.fn(),
}));

vi.mock('../target-state.js', () => ({
  getTargetStateColor: getTargetStateColorMock,
}));

describe('prepare command', () => {
  const target: ReviewTarget = {
    provider: 'bitbucket-cloud',
    repository: 'workspace/repo',
    targetType: 'pull_request',
    targetId: '42',
    title: 'Improve prepare',
    description: '',
    author: 'octocat',
    state: 'open',
    sourceBranch: 'feature',
    targetBranch: 'main',
    webUrl: 'https://bitbucket.org/workspace/repo/pull-requests/42',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    labels: [],
    diffRefs: {
      baseSha: 'base',
      headSha: 'head',
      startSha: 'start',
    },
  };

  const bundle: Pick<WorkspaceBundle, 'preparedAt' | 'target' | 'threads' | 'diffs'> = {
    preparedAt: '2026-01-01T00:00:00.000Z',
    target,
    threads: [],
    diffs: [],
  };

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    getRepoFromGitMock.mockResolvedValue('workspace/repo');
    getTargetStateColorMock.mockReturnValue((state: string) => `[state:${state}]`);
    prepareMock.mockResolvedValue({
      bundle,
      mode: 'fresh',
      targetCodeChanged: false,
      threadsChanged: false,
      descriptionChanged: false,
      hasCheckpoint: false,
      prunedReplies: 0,
      contextPath: '.revpack/CONTEXT.md',
    });
    createOrchestratorMock.mockResolvedValue({ prepare: prepareMock });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('formats the state output through the shared target state color lookup', async () => {
    await parsePrepare('#42');

    expect(getTargetStateColorMock).toHaveBeenCalledWith('open');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('[state:open]'));
  });

  async function parsePrepare(...args: string[]): Promise<void> {
    const program = new Command();
    program.exitOverride();
    registerPrepareCommand(program);

    await program.parseAsync(['node', 'revpack', 'prepare', ...args]);
  }
});
