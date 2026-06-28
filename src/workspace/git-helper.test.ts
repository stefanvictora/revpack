import { EventEmitter } from 'node:events';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock('node:child_process', () => childProcessMock);

const { GitHelper } = await import('./git-helper.js');

describe('GitHelper', () => {
  beforeEach(() => {
    childProcessMock.execFile.mockReset();
    childProcessMock.spawn.mockReset();

    childProcessMock.execFile.mockImplementation(
      (_command: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
        callback(null, 'main\n', '');
      },
    );

    childProcessMock.spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
  });

  it('applies long path config to execFile git commands', async () => {
    const git = new GitHelper('repo');

    await expect(git.currentBranch()).resolves.toBe('main');

    expect(childProcessMock.execFile).toHaveBeenCalledWith(
      'git',
      ['-c', 'core.longpaths=true', 'rev-parse', '--abbrev-ref', 'HEAD'],
      { cwd: 'repo' },
      expect.any(Function),
    );
  });

  it('applies long path config to streaming git commands', async () => {
    await expect(GitHelper.clone('https://example.com/acme/project.git', 'feature/x', 'parent')).resolves.toEqual(
      expect.stringContaining('project-feature-x'),
    );

    expect(childProcessMock.spawn).toHaveBeenCalledWith(
      'git',
      [
        '-c',
        'core.longpaths=true',
        'clone',
        '--depth',
        '1',
        '--branch',
        'feature/x',
        '--progress',
        'https://example.com/acme/project.git',
        'project-feature-x',
      ],
      { cwd: 'parent', stdio: 'inherit' },
    );
  });

  it('derives repository slugs from common HTTPS and SSH remotes', async () => {
    const urls = [
      ['https://bitbucket.org/workspace/repo.git', 'workspace/repo'],
      ['git@bitbucket.org:workspace/repo.git', 'workspace/repo'],
      ['ssh://git@bitbucket.org/workspace/repo.git', 'workspace/repo'],
      ['https://github.com/owner/repo.git', 'owner/repo'],
      ['git@gitlab.example.com:group/subgroup/project.git', 'group/subgroup/project'],
    ];

    for (const [url, slug] of urls) {
      childProcessMock.execFile.mockImplementationOnce(
        (_command: string, _args: string[], _options: unknown, callback: (...args: unknown[]) => void) => {
          callback(null, `${url}\n`, '');
        },
      );

      await expect(new GitHelper('repo').deriveRepoSlug()).resolves.toBe(slug);
    }
  });
});
