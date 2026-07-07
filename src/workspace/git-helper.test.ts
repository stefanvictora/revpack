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
      (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
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
      { cwd: 'parent', stdio: ['inherit', 'inherit', 'pipe'] },
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

  describe('clone stderr capture', () => {
    it('includes git stderr in error message on clone failure', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const stderr = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = stderr;
        queueMicrotask(() => {
          stderr.emit('data', Buffer.from('fatal: Remote branch gone not found in upstream origin\n'));
          child.emit('close', 128);
        });
        return child;
      });

      await expect(GitHelper.clone('https://example.com/repo.git', 'gone', 'parent')).rejects.toThrow(
        'Remote branch gone not found in upstream origin',
      );
    });

    it('falls back to exit code message when stderr is empty', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 128));
        return child;
      });

      await expect(GitHelper.clone('https://example.com/repo.git', 'branch', 'parent')).rejects.toThrow(
        'exited with code 128',
      );
    });
  });

  describe('fetchBranch with unshallow', () => {
    it('passes --unshallow when the repo is shallow', async () => {
      const git = new GitHelper('repo');

      // First execFile call: isShallow → 'true'
      // Second execFile call: the actual fetch
      childProcessMock.execFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, 'true\n', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, '', '');
        });

      await git.fetchBranch('main', 'origin', { unshallow: true, noTags: true });

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', '--no-tags', '--unshallow', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });

    it('falls back to plain fetch (no depth) when repo is not shallow', async () => {
      const git = new GitHelper('repo');

      // First call: isShallow → 'false'
      // Second call: the plain fetch (recursive call without unshallow)
      childProcessMock.execFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, 'false\n', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, '', '');
        });

      await git.fetchBranch('main', 'origin', { unshallow: true, noTags: true });

      // Should NOT include --unshallow or --depth
      expect(childProcessMock.execFile).toHaveBeenLastCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', '--no-tags', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });
  });

  describe('isShallow', () => {
    it('returns true for a shallow repository', async () => {
      childProcessMock.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, 'true\n', '');
        },
      );

      const git = new GitHelper('repo');
      await expect(git.isShallow()).resolves.toBe(true);
    });

    it('returns false for a complete repository', async () => {
      childProcessMock.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, 'false\n', '');
        },
      );

      const git = new GitHelper('repo');
      await expect(git.isShallow()).resolves.toBe(false);
    });

    it('returns false when git command fails', async () => {
      childProcessMock.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(new Error('not a git repo'), '', '');
        },
      );

      const git = new GitHelper('repo');
      await expect(git.isShallow()).resolves.toBe(false);
    });
  });

  describe('listReviewCommits', () => {
    it('lists non-merge commits oldest first with full messages', async () => {
      childProcessMock.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(
            null,
            [
              '1111111111111111111111111111111111111111',
              '1111111',
              'Alice',
              '2026-07-07',
              'Add parser\n\nExplain intent.\nTrailer: yes',
              '',
            ].join('\x00') +
              '\x1e\n' +
              ['2222222222222222222222222222222222222222', '2222222', 'Bob', '2026-07-08', 'Tighten tests', ''].join(
                '\x00',
              ) +
              '\x1e\n',
            '',
          );
        },
      );

      const git = new GitHelper('repo');
      await expect(git.listReviewCommits('aaa', 'bbb')).resolves.toEqual([
        {
          sha: '1111111111111111111111111111111111111111',
          shortSha: '1111111',
          authorName: 'Alice',
          authorDate: '2026-07-07',
          message: 'Add parser\n\nExplain intent.\nTrailer: yes',
        },
        {
          sha: '2222222222222222222222222222222222222222',
          shortSha: '2222222',
          authorName: 'Bob',
          authorDate: '2026-07-08',
          message: 'Tighten tests',
        },
      ]);

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'git',
        [
          '-c',
          'core.longpaths=true',
          'log',
          '--no-merges',
          '--reverse',
          '--date=short',
          '--format=%H%x00%h%x00%an%x00%ad%x00%B%x00%x1e',
          'aaa..bbb',
        ],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });

    it('returns an empty list when the range has no non-merge commits', async () => {
      childProcessMock.execFile.mockImplementationOnce(
        (_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, '', '');
        },
      );

      const git = new GitHelper('repo');
      await expect(git.listReviewCommits('aaa', 'bbb')).resolves.toEqual([]);
    });
  });

  describe('progress-mode fetch error capture', () => {
    it('includes stderr in error when progress-mode fetch fails', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const stderr = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = stderr;
        queueMicrotask(() => {
          stderr.emit('data', Buffer.from("fatal: couldn't find remote ref feature/gone\n"));
          child.emit('close', 128);
        });
        return child;
      });

      const git = new GitHelper('repo');
      // isShallow check for unshallow=false path isn't needed; just use depth
      await expect(
        git.fetchBranch('feature/gone', 'origin', { depth: 1, noTags: true, progress: true }),
      ).rejects.toThrow("couldn't find remote ref feature/gone");
    });

    it('trims trailing whitespace from captured stderr', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const stderr = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = stderr;
        queueMicrotask(() => {
          stderr.emit('data', Buffer.from('fatal: some error\n\n'));
          child.emit('close', 1);
        });
        return child;
      });

      const git = new GitHelper('repo');
      await expect(git.fetchBranch('main', 'origin', { depth: 1, progress: true })).rejects.toThrow(
        /^fatal: some error$/,
      );
    });

    it('forwards --progress flag to spawn args', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 0));
        return child;
      });

      const git = new GitHelper('repo');
      await git.fetchBranch('main', 'origin', { depth: 1, noTags: true, progress: true });

      expect(childProcessMock.spawn).toHaveBeenCalledWith('git', expect.arrayContaining(['--progress']), {
        cwd: 'repo',
        stdio: ['inherit', 'inherit', 'pipe'],
      });
    });

    it('falls back to exit code when stderr is empty', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 128));
        return child;
      });

      const git = new GitHelper('repo');
      await expect(git.fetchBranch('main', 'origin', { depth: 1, progress: true })).rejects.toThrow(
        /exited with code 128/,
      );
    });

    it('does not crash when child.stderr is null in progress mode', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = null;
        queueMicrotask(() => child.emit('close', 128));
        return child;
      });

      const git = new GitHelper('repo');
      await expect(git.fetchBranch('main', 'origin', { depth: 1, progress: true })).rejects.toThrow(
        /exited with code 128/,
      );
    });

    it('rejects with spawn error when git binary is not found', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('spawn git ENOENT')));
        return child;
      });

      const git = new GitHelper('repo');
      await expect(git.fetchBranch('main', 'origin', { depth: 1, progress: true })).rejects.toThrow('spawn git ENOENT');
    });
  });

  describe('fetchBranch without options', () => {
    it('works without options argument (no TypeError on undefined)', async () => {
      const git = new GitHelper('repo');
      await expect(git.fetchBranch('main')).resolves.toBeUndefined();

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });
  });

  describe('clone edge cases', () => {
    it('trims trailing whitespace from captured stderr', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        const stderr = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = stderr;
        queueMicrotask(() => {
          stderr.emit('data', Buffer.from('fatal: error message\r\n'));
          child.emit('close', 1);
        });
        return child;
      });

      await expect(GitHelper.clone('https://example.com/repo.git', 'b', 'p')).rejects.toThrow(/^fatal: error message$/);
    });

    it('does not crash when child.stderr is null', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = null;
        queueMicrotask(() => child.emit('close', 128));
        return child;
      });

      await expect(GitHelper.clone('https://example.com/repo.git', 'b', 'p')).rejects.toThrow('exited with code 128');
    });

    it('rejects with spawn error when git binary is not found', async () => {
      childProcessMock.spawn.mockImplementation(() => {
        const child = new EventEmitter();
        (child as unknown as Record<string, unknown>).stderr = new EventEmitter();
        queueMicrotask(() => child.emit('error', new Error('spawn git ENOENT')));
        return child;
      });

      await expect(GitHelper.clone('https://example.com/repo.git', 'b', 'p')).rejects.toThrow('spawn git ENOENT');
    });
  });

  describe('buildFetchArgs (via fetchBranch)', () => {
    it('includes --no-tags when noTags is set', async () => {
      const git = new GitHelper('repo');
      await git.fetchBranch('main', 'origin', { noTags: true });

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', '--no-tags', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });

    it('includes --depth when depth is set', async () => {
      const git = new GitHelper('repo');
      await git.fetchBranch('main', 'origin', { depth: 5 });

      expect(childProcessMock.execFile).toHaveBeenCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', '--depth=5', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });

    it('prefers --unshallow over --depth when both are set in a shallow repo', async () => {
      const git = new GitHelper('repo');

      childProcessMock.execFile
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, 'true\n', '');
        })
        .mockImplementationOnce((_cmd: string, _args: string[], _opts: unknown, cb: (...args: unknown[]) => void) => {
          cb(null, '', '');
        });

      await git.fetchBranch('main', 'origin', { unshallow: true, depth: 1, noTags: true });

      expect(childProcessMock.execFile).toHaveBeenLastCalledWith(
        'git',
        ['-c', 'core.longpaths=true', 'fetch', '--no-tags', '--unshallow', 'origin', 'main'],
        { cwd: 'repo' },
        expect.any(Function),
      );
    });
  });
});
