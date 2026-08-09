import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ProviderError } from '../../core/errors.js';
import { GitLabProvider } from './gitlab-provider.js';

const ref = {
  provider: 'gitlab' as const,
  repository: 'group/project',
  targetType: 'merge_request' as const,
  targetId: '42',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
}

function installFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return handler(url, init);
    }),
  );
}

function requestBodyJson(init?: RequestInit): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected a JSON request body');
  return JSON.parse(init.body) as unknown;
}

describe('GitLabProvider.resolveTarget', () => {
  const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');

  it('parses full URL', () => {
    const ref = provider.resolveTarget('https://gitlab.example.com/group/project/-/merge_requests/42');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });
  });

  it('parses http:// URLs', () => {
    const ref = provider.resolveTarget('http://gitlab.local/group/project/-/merge_requests/7');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '7',
    });
  });

  it('parses repo!id format', () => {
    const ref = provider.resolveTarget('my-group/my-project!123');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'my-group/my-project',
      targetType: 'merge_request',
      targetId: '123',
    });
  });

  it('parses !id format (no repo)', () => {
    const ref = provider.resolveTarget('!99');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: '',
      targetType: 'merge_request',
      targetId: '99',
    });
  });

  it('parses bare numeric id', () => {
    const ref = provider.resolveTarget('77');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: '',
      targetType: 'merge_request',
      targetId: '77',
    });
  });

  it('rejects unparseable refs', () => {
    expect(() => provider.resolveTarget('not-a-ref')).toThrow('Cannot parse');
  });

  it('parses nested group URL', () => {
    const ref = provider.resolveTarget('https://gitlab.example.com/org/team/project/-/merge_requests/5');
    expect(ref).toEqual({
      provider: 'gitlab',
      repository: 'org/team/project',
      targetType: 'merge_request',
      targetId: '5',
    });
  });

  it('rejects repo!id format with trailing content', () => {
    expect(() => provider.resolveTarget('group/project!123suffix')).toThrow('Cannot parse');
  });

  it('rejects bare numbers with trailing text', () => {
    expect(() => provider.resolveTarget('42abc')).toThrow('Cannot parse');
  });

  it('rejects bare numbers with leading text', () => {
    expect(() => provider.resolveTarget('abc42')).toThrow('Cannot parse');
  });

  it('rejects !id with trailing text', () => {
    expect(() => provider.resolveTarget('!42abc')).toThrow('Cannot parse');
  });
});

describe('GitLabProvider constructor and options', () => {
  it('strips trailing slashes from base URL', () => {
    const provider = new GitLabProvider('https://gitlab.example.com///', 'token');
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });

  it('uses SSH clone URL when sshClone is enabled', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token', { sshClone: true });
    expect(provider.getCloneUrl('group/project')).toBe('git@gitlab.example.com:group/project.git');
  });

  it('uses HTTPS clone URL when sshClone is disabled', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token', { sshClone: false });
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });

  it('uses HTTPS clone URL by default when sshClone is not specified', () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token');
    expect(provider.getCloneUrl('group/project')).toBe('https://gitlab.example.com/group/project.git');
  });
});

describe('GitLabProvider historical diff versions', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps a provider-retained diff version into review diffs', async () => {
    installFetch((url) => {
      expect(url).toContain('/merge_requests/42/versions/7');
      return jsonResponse({
        id: 7,
        base_commit_sha: 'base-sha',
        head_commit_sha: 'head-sha',
        start_commit_sha: 'start-sha',
        created_at: '2026-01-01T00:00:00Z',
        diffs: [
          {
            old_path: 'src/old.ts',
            new_path: 'src/new.ts',
            diff: '@@ -1 +1 @@\n-old\n+new',
            new_file: false,
            renamed_file: true,
            deleted_file: false,
          },
        ],
      });
    });

    const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');

    await expect(provider.getDiffVersionDiffs(ref, '7')).resolves.toEqual([
      {
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        diff: '@@ -1 +1 @@\n-old\n+new',
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      },
    ]);
  });
});

describe('GitLabProvider checkout fallback', () => {
  const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');

  it('returns the temporary MR head ref and deterministic local branch', () => {
    const fallback = provider.getCheckoutFallbackRef({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });

    expect(fallback).toEqual({
      remoteRef: 'refs/merge-requests/42/head',
      localBranch: 'revpack/mr-42',
    });
  });

  it('returns the fallback branch for bundle-shaped targets', () => {
    const branch = provider.getCheckoutFallbackBranch({
      provider: 'gitlab',
      type: 'merge_request',
      id: '42',
      sourceBranch: 'feature/test',
    });

    expect(branch).toBe('revpack/mr-42');
  });

  it('formats the GitLab temporary-ref expiration message', () => {
    const error = provider.formatCheckoutFallbackError(
      {
        provider: 'gitlab',
        repository: 'group/project',
        targetType: 'merge_request',
        targetId: '42',
        title: 'Test MR',
        description: 'Test',
        author: 'alice',
        state: 'merged',
        sourceBranch: 'feature/test',
        targetBranch: 'main',
        webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        labels: [],
        diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
      },
      new Error('source branch missing'),
      new Error('MR head ref missing'),
    );

    expect(error.message).toContain('source branch "feature/test" may have been deleted');
    expect(error.message).toContain('refs/merge-requests/42/head');
    expect(error.message).toContain('GitLab 16.6 and newer');
    expect(error.message).toContain('14 days after merge or close');
  });
});

describe('GitLabProvider Code Spans', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('preserves multi-line positions returned by GitLab discussions', async () => {
    installFetch((url) => {
      expect(url).toContain('/api/v4/projects/group%2Fproject/merge_requests/42/discussions');
      return jsonResponse([
        {
          id: 'discussion-1',
          notes: [
            {
              id: 1,
              body: 'Range comment',
              author: { username: 'reviewer' },
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              resolvable: true,
              resolved: false,
              position: {
                old_path: 'src/app.ts',
                new_path: 'src/app.ts',
                old_line: 12,
                new_line: 14,
                line_range: {
                  start: {
                    line_code: 'hash_8_10',
                    type: 'old',
                    old_line: 8,
                    new_line: 10,
                  },
                  end: {
                    line_code: 'hash_12_14',
                    type: 'old',
                    old_line: 12,
                    new_line: 14,
                  },
                },
              },
            },
          ],
        },
      ]);
    });

    const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');
    const threads = await provider.listAllThreads(ref);

    expect(threads[0].position).toMatchObject({
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      oldStartLine: 8,
      newStartLine: 10,
      oldLine: 12,
      newLine: 14,
    });
  });

  it('posts multi-line findings using GitLab line_range positions', async () => {
    let discussionBody: unknown;
    installFetch((url, init) => {
      if (url.endsWith('/versions')) {
        return jsonResponse([
          {
            id: 1,
            base_commit_sha: 'base-sha',
            head_commit_sha: 'head-sha',
            start_commit_sha: 'start-sha',
            created_at: '2026-01-01T00:00:00Z',
          },
        ]);
      }
      if (url.endsWith('/discussions')) {
        discussionBody = requestBodyJson(init);
        return jsonResponse({ id: 'discussion-2', notes: [] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const provider = new GitLabProvider('https://gitlab.example.com', 'fake-token');
    await expect(
      provider.createThread(ref, 'Range finding', {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newStartLine: 10,
        newLine: 12,
      }),
    ).resolves.toBe('discussion-2');

    expect(discussionBody).toMatchObject({
      position: {
        new_line: 12,
        line_range: {
          start: {
            line_code: '216381173f187cf4c2baf119193855699f4bc616_10_10',
            type: 'new',
            new_line: 10,
          },
          end: {
            line_code: '216381173f187cf4c2baf119193855699f4bc616_12_12',
            type: 'new',
            new_line: 12,
          },
        },
      },
    });
  });
});

describe('GitLabProvider errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('raises authentication errors for 401 responses', async () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'bad-token');
    installFetch(() => jsonResponse({ message: 'bad credentials' }, { status: 401, statusText: 'Unauthorized' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow(AuthenticationError);
  });

  it('raises access errors for 403 responses', async () => {
    const provider = new GitLabProvider('https://gitlab.example.com', 'token-without-access');
    installFetch(() => jsonResponse({ message: 'forbidden' }, { status: 403, statusText: 'Forbidden' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow(ProviderError);
    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow('repository permissions and token scopes');
  });
});
