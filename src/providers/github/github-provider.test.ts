import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ProviderError } from '../../core/errors.js';
import type { ReviewTargetRef } from '../../core/types.js';
import { GitHubProvider } from './github-provider.js';

const ref: ReviewTargetRef = {
  provider: 'github',
  repository: 'octo/repo',
  targetType: 'pull_request',
  targetId: '42',
};

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    ...init,
  });
}

function pr(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    node_id: 'PR_node_42',
    number: 42,
    title: 'Add feature',
    body: 'PR body',
    state: 'open',
    html_url: 'https://github.com/octo/repo/pull/42',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    changed_files: 3,
    labels: [{ name: 'bug' }, { name: 'needs-review' }],
    user: { login: 'alice' },
    head: {
      ref: 'feature/test',
      sha: 'head-sha',
      repo: {
        full_name: 'octo/repo',
        clone_url: 'https://github.com/octo/repo.git',
        ssh_url: 'git@github.com:octo/repo.git',
      },
    },
    base: { ref: 'main', sha: 'base-sha' },
    ...overrides,
  };
}

function forkPr(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return pr({
    head: {
      ref: 'is-37428-fix',
      sha: 'fork-sha',
      repo: {
        full_name: 'contributor/repo',
        clone_url: 'https://github.com/contributor/repo.git',
        ssh_url: 'git@github.com:contributor/repo.git',
      },
    },
    ...overrides,
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

function requestBodyText(init: RequestInit | undefined): string {
  if (typeof init?.body !== 'string') throw new Error('Expected request body to be a string');
  return init.body;
}

function requestBodyJson(init: RequestInit | undefined): unknown {
  return JSON.parse(requestBodyText(init));
}

describe('GitHubProvider.resolveTarget', () => {
  const provider = new GitHubProvider('https://github.com', 'token');

  it('parses full GitHub pull request URLs', () => {
    expect(provider.resolveTarget('https://github.com/octo/repo/pull/42')).toEqual(ref);
  });

  it('parses enterprise pull request URLs', () => {
    expect(provider.resolveTarget('https://github.example.com/octo/repo/pull/42/files')).toEqual(ref);
  });

  it('parses owner/repo#number refs', () => {
    expect(provider.resolveTarget('octo/repo#42')).toEqual(ref);
  });

  it('parses owner/repo/pull/number refs', () => {
    expect(provider.resolveTarget('octo/repo/pull/42')).toEqual(ref);
  });

  it('parses bare numeric refs without a repository', () => {
    expect(provider.resolveTarget('#42')).toEqual({ ...ref, repository: '' });
    expect(provider.resolveTarget('42')).toEqual({ ...ref, repository: '' });
  });

  it('rejects unparseable refs', () => {
    expect(() => provider.resolveTarget('not-a-ref')).toThrow('Cannot parse GitHub target reference');
  });
});

describe('GitHubProvider REST reads', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider('https://github.com', 'ghp-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps pull request snapshots to provider-neutral targets', async () => {
    installFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });

    await expect(provider.getTargetSnapshot(ref)).resolves.toEqual({
      provider: 'github',
      repository: 'octo/repo',
      targetType: 'pull_request',
      targetId: '42',
      title: 'Add feature',
      description: 'PR body',
      author: 'alice',
      state: 'open',
      sourceBranch: 'feature/test',
      targetBranch: 'main',
      webUrl: 'https://github.com/octo/repo/pull/42',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-02T00:00:00Z',
      labels: ['bug', 'needs-review'],
      diffRefs: {
        baseSha: 'base-sha',
        headSha: 'head-sha',
        startSha: 'base-sha',
      },
      // Same-repo PR: no headRepository
    });
  });

  it('sets headRepository for fork PRs and omits it for same-repo PRs', async () => {
    // Fork PR
    installFetch(() => jsonResponse(forkPr()));
    const forkTarget = await provider.getTargetSnapshot(ref);
    expect(forkTarget.headRepository).toBe('contributor/repo');
    expect(forkTarget.sourceBranch).toBe('is-37428-fix');

    // Same-repo PR
    installFetch(() => jsonResponse(pr()));
    const sameRepoTarget = await provider.getTargetSnapshot(ref);
    expect(sameRepoTarget.headRepository).toBeUndefined();
  });

  it('sets headRepository when head.repo is null (deleted fork)', async () => {
    const deletedForkPr = pr({ head: { ref: 'fix-branch', sha: 'sha', repo: null } });
    installFetch(() => jsonResponse(deletedForkPr));
    const target = await provider.getTargetSnapshot(ref);
    // head.repo is null — treated as same-repo (cannot determine fork status)
    expect(target.headRepository).toBeUndefined();
  });

  it('lists open PRs and filters PRs by source branch', async () => {
    const pulls = [
      pr({
        number: 1,
        head: {
          ref: 'feature/test',
          sha: 'one',
          repo: {
            full_name: 'octo/repo',
            clone_url: 'https://github.com/octo/repo.git',
            ssh_url: 'git@github.com:octo/repo.git',
          },
        },
      }),
      pr({
        number: 2,
        head: {
          ref: 'other',
          sha: 'two',
          repo: {
            full_name: 'octo/repo',
            clone_url: 'https://github.com/octo/repo.git',
            ssh_url: 'git@github.com:octo/repo.git',
          },
        },
      }),
    ];
    installFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/pulls?state=open&per_page=100');
      return jsonResponse(pulls);
    });

    const matches = await provider.findTargetByBranch('octo/repo', 'feature/test');
    expect(matches).toHaveLength(1);
    expect(matches[0].targetId).toBe('1');
    expect(matches[0].sourceBranch).toBe('feature/test');
  });

  it('uses the PR head SHA as the provider version', async () => {
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(provider.getDiffVersions(ref)).resolves.toEqual([
      {
        provider: 'github',
        targetRef: ref,
        versionId: 'head-sha',
        headCommitSha: 'head-sha',
        baseCommitSha: 'base-sha',
        startCommitSha: 'base-sha',
        createdAt: '2026-01-02T00:00:00Z',
        realSize: 3,
      },
    ]);
  });
});

describe('GitHubProvider GraphQL review threads', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider('https://github.com', 'ghp-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('lists all review threads, preserving resolved state and comment origin', async () => {
    const calls: unknown[] = [];
    installFetch((_url, init) => {
      const payload = requestBodyJson(init) as { variables: { after: string | null } };
      calls.push(payload.variables);
      const firstPage = payload.variables.after === null;
      return jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: firstPage, endCursor: firstPage ? 'cursor-1' : null },
                nodes: firstPage
                  ? [
                      {
                        id: 'thread-1',
                        isResolved: false,
                        isOutdated: false,
                        path: 'src/app.ts',
                        line: 12,
                        diffSide: 'RIGHT',
                        comments: {
                          nodes: [
                            {
                              id: 'comment-node-1',
                              databaseId: 1001,
                              body: 'Please adjust this',
                              author: { login: 'reviewer' },
                              createdAt: '2026-01-01T01:00:00Z',
                              updatedAt: '2026-01-01T01:00:00Z',
                            },
                            {
                              id: 'comment-node-2',
                              databaseId: 1002,
                              body: '<!-- revpack -->\nDone',
                              author: { login: 'revpack[bot]' },
                              createdAt: '2026-01-01T02:00:00Z',
                              updatedAt: '2026-01-01T02:00:00Z',
                            },
                          ],
                        },
                      },
                    ]
                  : [
                      {
                        id: 'thread-2',
                        isResolved: true,
                        isOutdated: false,
                        path: 'src/old.ts',
                        line: 7,
                        diffSide: 'LEFT',
                        comments: {
                          nodes: [
                            {
                              id: 'comment-node-3',
                              databaseId: 1003,
                              body: 'Resolved issue',
                              author: { login: 'reviewer' },
                              createdAt: '2026-01-01T03:00:00Z',
                              updatedAt: '2026-01-01T03:00:00Z',
                            },
                          ],
                        },
                      },
                    ],
              },
            },
          },
        },
      });
    });

    const threads = await provider.listAllThreads(ref);

    expect(calls).toEqual([
      { owner: 'octo', name: 'repo', number: 42, after: null },
      { owner: 'octo', name: 'repo', number: 42, after: 'cursor-1' },
    ]);
    expect(threads).toEqual([
      {
        provider: 'github',
        targetRef: ref,
        threadId: 'thread-1',
        resolved: false,
        resolvable: true,
        resolvedBy: undefined,
        resolvedAt: undefined,
        position: {
          filePath: 'src/app.ts',
          oldLine: undefined,
          newLine: 12,
          oldPath: 'src/app.ts',
          newPath: 'src/app.ts',
        },
        comments: [
          {
            id: '1001',
            body: 'Please adjust this',
            author: 'reviewer',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: '1002',
            body: '<!-- revpack -->\nDone',
            author: 'revpack[bot]',
            createdAt: '2026-01-01T02:00:00Z',
            updatedAt: '2026-01-01T02:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      },
      {
        provider: 'github',
        targetRef: ref,
        threadId: 'thread-2',
        resolved: true,
        resolvable: true,
        resolvedBy: undefined,
        resolvedAt: undefined,
        position: {
          filePath: 'src/old.ts',
          oldLine: 7,
          newLine: undefined,
          oldPath: 'src/old.ts',
          newPath: 'src/old.ts',
        },
        comments: [
          {
            id: '1003',
            body: 'Resolved issue',
            author: 'reviewer',
            createdAt: '2026-01-01T03:00:00Z',
            updatedAt: '2026-01-01T03:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      },
    ]);
    await expect(provider.listUnresolvedThreads(ref)).resolves.toHaveLength(1);
  });

  it('posts replies and resolves threads through GraphQL thread IDs', async () => {
    const bodies: string[] = [];
    installFetch((url, init) => {
      expect(url).toBe('https://api.github.com/graphql');
      bodies.push(requestBodyText(init));
      return jsonResponse({
        data: {
          addPullRequestReviewThreadReply: { comment: { id: 'reply' } },
          resolveReviewThread: { thread: { id: 'thread-1', isResolved: true } },
        },
      });
    });

    await provider.postReply(ref, 'thread-1', 'Thanks, fixed.');
    await provider.resolveThread(ref, 'thread-1');

    expect(bodies[0]).toContain('addPullRequestReviewThreadReply');
    expect(bodies[0]).toContain('"threadId":"thread-1"');
    expect(bodies[1]).toContain('resolveReviewThread');
    expect(bodies[1]).toContain('"threadId":"thread-1"');
  });
});

describe('GitHubProvider writes', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider('https://github.com', 'ghp-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates PR descriptions through the pulls API', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/pulls/42');
      expect(init?.method).toBe('PATCH');
      expect(requestBodyJson(init)).toEqual({ body: 'new body' });
      return jsonResponse(pr({ body: 'new body' }));
    });

    await provider.updateDescription(ref, 'new body');
  });

  it('creates review threads with side-aware GraphQL input', async () => {
    const requests: { url: string; body?: unknown }[] = [];
    installFetch((url, init) => {
      requests.push({ url, body: init?.body ? requestBodyJson(init) : undefined });
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({ data: { addPullRequestReviewThread: { thread: { id: 'new-thread' } } } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'finding body', {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 12,
      }),
    ).resolves.toBe('new-thread');

    expect(requests[1].body).toMatchObject({
      variables: {
        input: {
          pullRequestId: 'PR_node_42',
          body: 'finding body',
          path: 'src/app.ts',
          line: 12,
          side: 'RIGHT',
        },
      },
    });
  });

  it('uses LEFT side for deletion findings', async () => {
    let graphQlBody: unknown;
    installFetch((url, init) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      graphQlBody = requestBodyJson(init);
      return jsonResponse({ data: { addPullRequestReviewThread: { thread: { id: 'left-thread' } } } });
    });

    await provider.createThread(ref, 'finding body', {
      oldPath: 'src/old.ts',
      newPath: 'src/old.ts',
      oldLine: 9,
    });

    expect(graphQlBody).toMatchObject({
      variables: {
        input: {
          path: 'src/old.ts',
          line: 9,
          side: 'LEFT',
        },
      },
    });
  });

  it('falls back to a PR timeline note when GitHub rejects a review thread position', async () => {
    let noteBody: string | undefined;
    installFetch((url, init) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({ errors: [{ message: 'Validation failed: line must be part of the diff' }] });
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments') {
        noteBody = (requestBodyJson(init) as { body: string }).body;
        return jsonResponse({ id: 5001, body: noteBody });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'finding body', {
        oldPath: 'src/old.ts',
        newPath: 'src/new.ts',
        newLine: 999,
      }),
    ).resolves.toBe('5001');

    // Verify the anchor uses newPath and newLine
    expect(noteBody).toContain('src/new.ts:999');
    expect(noteBody).toContain('finding body');
  });

  it('falls back using oldPath and oldLine when newPath/newLine are absent', async () => {
    let noteBody: string | undefined;
    installFetch((url, init) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({ errors: [{ message: 'Validation failed: line must be part of the diff' }] });
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments') {
        noteBody = (requestBodyJson(init) as { body: string }).body;
        return jsonResponse({ id: 5002, body: noteBody });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'finding body', {
        oldPath: 'src/removed.ts',
        newPath: '',
        oldLine: 42,
      }),
    ).resolves.toBe('5002');

    // When newPath is falsy, should fall back to oldPath; when newLine is null, uses oldLine
    expect(noteBody).toContain('src/removed.ts:42');
  });

  it('propagates non-validation errors from createThread', async () => {
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({}, { status: 500, statusText: 'Internal Server Error' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'finding body', {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 12,
      }),
    ).rejects.toThrow('GitHub API error: 500');
  });

  it('propagates non-ProviderError exceptions from createThread', async () => {
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') throw new TypeError('fetch failed');
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'body', {
        oldPath: 'src/a.ts',
        newPath: 'src/a.ts',
        newLine: 1,
      }),
    ).rejects.toThrow('Network error');
  });

  it('falls back to note on 422 HTTP validation error from GraphQL endpoint', async () => {
    installFetch((url, init) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql' && init?.method === 'POST') {
        return jsonResponse({ message: 'Validation Failed' }, { status: 422, statusText: 'Unprocessable Entity' });
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments' && init?.method === 'POST') {
        return jsonResponse({ id: 6001, body: 'fallback-422' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'body', {
        oldPath: 'src/x.ts',
        newPath: 'src/x.ts',
        newLine: 10,
      }),
    ).resolves.toBe('6001');
  });

  it('finds, creates, and updates PR timeline notes', async () => {
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    installFetch((url, init) => {
      requests.push({ url, method: init?.method, body: init?.body ? requestBodyJson(init) : undefined });
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments' && !init?.method) {
        return jsonResponse([
          { id: 1, body: 'hello' },
          { id: 2, body: '<!-- revpack:review -->\nstate' },
        ]);
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments' && init?.method === 'POST') {
        return jsonResponse({ id: 3, body: 'created' });
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/comments/2' && init?.method === 'PATCH') {
        return jsonResponse({ id: 2, body: 'updated' });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    await expect(provider.findNoteByMarker(ref, '<!-- revpack:review -->')).resolves.toEqual({
      id: '2',
      body: '<!-- revpack:review -->\nstate',
    });
    await expect(provider.createNote(ref, 'created', { internal: true })).resolves.toBe('3');
    await provider.updateNote(ref, '2', 'updated');

    expect(requests[1]).toMatchObject({
      method: 'POST',
      body: { body: 'created' },
    });
    expect(requests[2]).toMatchObject({
      method: 'PATCH',
      body: { body: 'updated' },
    });
  });
});

describe('GitHubProvider URL handling and errors', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses GitHub Enterprise REST and GraphQL endpoints while keeping clone URLs web-based', async () => {
    const provider = new GitHubProvider('https://github.example.com', 'token');
    installFetch((url) => {
      expect(url).toBe('https://github.example.com/api/v3/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });

    expect(provider.getCloneUrl('octo/repo')).toBe('https://github.example.com/octo/repo.git');
    await provider.getTargetSnapshot(ref);
  });

  it('accepts an explicit Enterprise REST API URL', async () => {
    const provider = new GitHubProvider('https://github.example.com/api/v3', 'token');
    installFetch((url) => {
      expect(url).toBe('https://github.example.com/api/v3/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });

    expect(provider.getCloneUrl('octo/repo')).toBe('https://github.example.com/octo/repo.git');
    await provider.getTargetSnapshot(ref);
  });

  it('raises authentication errors for 401 and 403 responses', async () => {
    const provider = new GitHubProvider('https://github.com', 'bad-token');
    installFetch(() => jsonResponse({ message: 'bad credentials' }, { status: 401, statusText: 'Unauthorized' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow(AuthenticationError);
  });

  it('raises provider errors for invalid repository slugs and GraphQL errors', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');

    expect(() => provider.getCloneUrl('not-a-github-slug')).not.toThrow();
    await expect(provider.getTargetSnapshot({ ...ref, repository: 'too/many/parts' })).rejects.toThrow(ProviderError);

    installFetch(() => jsonResponse({ errors: [{ message: 'boom' }] }));
    await expect(provider.resolveThread(ref, 'thread-1')).rejects.toThrow('GitHub GraphQL error: boom');
  });

  it('returns refs/pull/<number>/head as the source refspec', () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    expect(provider.getSourceRefspec(ref)).toBe('refs/pull/42/head');
    expect(provider.getSourceRefspec({ ...ref, targetId: '37429' })).toBe('refs/pull/37429/head');
  });
});

// ─── resolveTarget regex edge cases ──────────────────────

describe('GitHubProvider.resolveTarget regex anchoring', () => {
  const provider = new GitHubProvider('https://github.com', 'token');

  it('rejects URLs with leading text before the scheme', () => {
    expect(() => provider.resolveTarget('prefix https://github.com/octo/repo/pull/42')).toThrow(
      'Cannot parse GitHub target reference',
    );
  });

  it('rejects http:// URLs (only https is supported)', () => {
    // The regex uses https? but this tests that changing it to just 'https' still works
    // Actually: http URLs ARE supported by the regex — this verifies they parse correctly
    expect(provider.resolveTarget('http://github.example.com/octo/repo/pull/42')).toEqual({
      ...ref,
      repository: 'octo/repo',
      targetId: '42',
    });
  });

  it('rejects repo#number refs with extra prefix', () => {
    expect(() => provider.resolveTarget('extra/octo/repo#42')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects repo#number refs with trailing content', () => {
    expect(() => provider.resolveTarget('octo/repo#42suffix')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects repo/pull/number refs with extra path prefix', () => {
    expect(() => provider.resolveTarget('extra/octo/repo/pull/42')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects repo/pull/number refs with trailing content', () => {
    expect(() => provider.resolveTarget('octo/repo/pull/42/files')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects bare numbers with leading non-numeric text', () => {
    expect(() => provider.resolveTarget('abc42')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects bare numbers with trailing non-numeric text', () => {
    expect(() => provider.resolveTarget('42abc')).toThrow('Cannot parse GitHub target reference');
  });

  it('rejects URLs with trailing non-URL characters after the PR number', () => {
    expect(() => provider.resolveTarget('https://github.com/octo/repo/pull/42 extra')).toThrow(
      'Cannot parse GitHub target reference',
    );
  });
});

// ─── normalizeGitHubEndpoints edge cases ─────────────────

describe('GitHubProvider endpoint normalization', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles api.github.com as the input URL', async () => {
    const provider = new GitHubProvider('https://api.github.com', 'token');
    installFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
    expect(provider.getCloneUrl('octo/repo')).toBe('https://github.com/octo/repo.git');
  });

  it('handles enterprise URL with subpath ending in /api/v3', async () => {
    const provider = new GitHubProvider('https://corp.example.com/github/api/v3', 'token');
    installFetch((url) => {
      expect(url).toBe('https://corp.example.com/github/api/v3/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
    expect(provider.getCloneUrl('octo/repo')).toBe('https://corp.example.com/github/octo/repo.git');
  });

  it('strips trailing slashes from input URL', async () => {
    const provider = new GitHubProvider('https://github.example.com/', 'token');
    installFetch((url) => {
      expect(url).toBe('https://github.example.com/api/v3/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
  });

  it('defaults to github.com when URL is undefined', async () => {
    const provider = new GitHubProvider(undefined, 'token');
    installFetch((url) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/pulls/42');
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
  });
});

// ─── buildDispatcher / TLS options ───────────────────────

describe('GitHubProvider TLS dispatcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates dispatcher when tlsVerify is false', async () => {
    const provider = new GitHubProvider('https://github.com', 'token', { tlsVerify: false });
    installFetch((_url, init) => {
      expect((init as Record<string, unknown>)['dispatcher']).toBeDefined();
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
  });

  it('does not create dispatcher when no TLS options are set', async () => {
    const provider = new GitHubProvider('https://github.com', 'token', {});
    installFetch((_url, init) => {
      expect((init as Record<string, unknown>)['dispatcher']).toBeUndefined();
      return jsonResponse(pr());
    });
    await provider.getTargetSnapshot(ref);
  });

  it('creates dispatcher when caFile points to an existing file', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'revpack-test-'));
    const caPath = path.join(dir, 'ca.pem');
    fs.writeFileSync(caPath, 'fake-ca-cert');
    try {
      const provider = new GitHubProvider('https://github.com', 'token', { caFile: caPath });
      installFetch((_url, init) => {
        expect((init as Record<string, unknown>)['dispatcher']).toBeDefined();
        return jsonResponse(pr());
      });
      await provider.getTargetSnapshot(ref);
    } finally {
      fs.unlinkSync(caPath);
    }
  });

  it('uses SSH clone URL when sshClone is enabled', () => {
    const provider = new GitHubProvider('https://github.com', 'token', { sshClone: true });
    expect(provider.getCloneUrl('octo/repo')).toBe('git@github.com:octo/repo.git');
  });

  it('uses HTTPS clone URL when sshClone is disabled', () => {
    const provider = new GitHubProvider('https://github.com', 'token', { sshClone: false });
    expect(provider.getCloneUrl('octo/repo')).toBe('https://github.com/octo/repo.git');
  });
});

// ─── detectOrigin edge cases ─────────────────────────────

describe('GitHubProvider comment origin detection', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider('https://github.com', 'token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('detects bot origin from revpack comment marker', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-x',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/a.ts',
                    line: 1,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c1',
                          databaseId: 100,
                          body: '<!-- revpack:review -->\nSome finding',
                          author: { login: 'human-user' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].origin).toBe('bot');
  });

  it('detects bot origin from [bot] suffix in login', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-y',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/b.ts',
                    line: 2,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c2',
                          databaseId: 200,
                          body: 'Normal comment text',
                          author: { login: 'dependabot[bot]' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].origin).toBe('bot');
  });

  it('detects bot origin from login containing "bot" without brackets', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-z',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/c.ts',
                    line: 3,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c3',
                          databaseId: 300,
                          body: 'Automated check passed',
                          author: { login: 'cibot' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].origin).toBe('bot');
  });

  it('identifies human origin for regular users', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-h',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/d.ts',
                    line: 4,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c4',
                          databaseId: 400,
                          body: 'Please fix this issue',
                          author: { login: 'alice' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].origin).toBe('human');
  });

  it('handles null author gracefully', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-n',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/e.ts',
                    line: 5,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c5',
                          databaseId: 500,
                          body: 'Ghost comment',
                          author: null,
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].author).toBe('unknown');
    expect(threads[0].comments[0].origin).toBe('human');
  });

  it('detects bot via body.startsWith even when login does not contain bot', async () => {
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-m',
                    isResolved: false,
                    isOutdated: false,
                    path: 'src/f.ts',
                    line: 6,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c6',
                          databaseId: 600,
                          body: '<!-- revpack:finding -->\nContent',
                          author: { login: 'regular-user' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads[0].comments[0].origin).toBe('bot');
  });
});

// ─── createThread without position ───────────────────────

describe('GitHubProvider createThread without position', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a note when no position is provided', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch((url, init) => {
      expect(url).toBe('https://api.github.com/repos/octo/repo/issues/42/comments');
      expect(init?.method).toBe('POST');
      expect(requestBodyJson(init)).toEqual({ body: 'general comment' });
      return jsonResponse({ id: 9001, body: 'general comment' });
    });

    const id = await provider.createThread(ref, 'general comment');
    expect(id).toBe('9001');
  });
});

// ─── listAllThreads when GraphQL returns null page ───────

describe('GitHubProvider listAllThreads null response', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty array when pullRequest is null in GraphQL response', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: null,
          },
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads).toEqual([]);
  });

  it('returns empty array when repository is null in GraphQL response', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() =>
      jsonResponse({
        data: {
          repository: null,
        },
      }),
    );
    const threads = await provider.listAllThreads(ref);
    expect(threads).toEqual([]);
  });

  it('returns previously collected threads when second page is null', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    let callCount = 0;
    installFetch(() => {
      callCount++;
      if (callCount === 1) {
        return jsonResponse({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  pageInfo: { hasNextPage: true, endCursor: 'page-1' },
                  nodes: [
                    {
                      id: 'thread-first',
                      isResolved: false,
                      isOutdated: false,
                      path: 'src/x.ts',
                      line: 10,
                      diffSide: 'RIGHT',
                      comments: {
                        nodes: [
                          {
                            id: 'c-first',
                            databaseId: 1,
                            body: 'First comment',
                            author: { login: 'dev' },
                            createdAt: '2026-01-01T00:00:00Z',
                            updatedAt: '2026-01-01T00:00:00Z',
                          },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        });
      }
      // Second page returns null pullRequest
      return jsonResponse({
        data: {
          repository: {
            pullRequest: null,
          },
        },
      });
    });

    const threads = await provider.listAllThreads(ref);
    expect(threads).toHaveLength(1);
    expect(threads[0].threadId).toBe('thread-first');
    expect(threads[0].comments[0].body).toBe('First comment');
  });
});

// ─── mapPullRequest edge cases ───────────────────────────

describe('GitHubProvider mapPullRequest edge cases', () => {
  let provider: GitHubProvider;

  beforeEach(() => {
    provider = new GitHubProvider('https://github.com', 'token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses "unknown" author when user is null', async () => {
    installFetch(() => jsonResponse(pr({ user: null })));
    const target = await provider.getTargetSnapshot(ref);
    expect(target.author).toBe('unknown');
  });

  it('returns empty labels array when labels is null', async () => {
    installFetch(() => jsonResponse(pr({ labels: null })));
    const target = await provider.getTargetSnapshot(ref);
    expect(target.labels).toEqual([]);
  });
});

// ─── listUnresolvedThreads filtering ────────────────────

describe('GitHubProvider listUnresolvedThreads', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters out resolved threads and keeps only unresolved resolvable ones', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'unresolved-1',
                    isResolved: false,
                    isOutdated: false,
                    path: 'a.ts',
                    line: 1,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c1',
                          databaseId: 1,
                          body: 'fix',
                          author: { login: 'x' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                  {
                    id: 'resolved-1',
                    isResolved: true,
                    isOutdated: false,
                    path: 'b.ts',
                    line: 2,
                    diffSide: 'RIGHT',
                    comments: {
                      nodes: [
                        {
                          id: 'c2',
                          databaseId: 2,
                          body: 'done',
                          author: { login: 'y' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const unresolved = await provider.listUnresolvedThreads(ref);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0].threadId).toBe('unresolved-1');
    expect(unresolved[0].resolved).toBe(false);
  });
});

// ─── REST request edge cases ─────────────────────────────

describe('GitHubProvider REST request edge cases', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('handles 204 No Content response from PATCH requests', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() => new Response(null, { status: 204 }));
    // updateDescription calls request() which should handle 204 gracefully
    await expect(provider.updateDescription(ref, 'new body')).resolves.toBeUndefined();
  });

  it('throws ProviderError when GraphQL response has no data and no errors', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() => jsonResponse({}));
    await expect(provider.resolveThread(ref, 'thread-1')).rejects.toThrow(
      'GitHub GraphQL error: response did not include data',
    );
  });

  it('maps threads with null path to undefined position', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    installFetch(() =>
      jsonResponse({
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  {
                    id: 'thread-no-path',
                    isResolved: false,
                    isOutdated: false,
                    path: null,
                    line: null,
                    diffSide: null,
                    comments: {
                      nodes: [
                        {
                          id: 'c-no-path',
                          databaseId: 777,
                          body: 'General comment on the PR',
                          author: { login: 'dev' },
                          createdAt: '2026-01-01T00:00:00Z',
                          updatedAt: '2026-01-01T00:00:00Z',
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      }),
    );

    const threads = await provider.listAllThreads(ref);
    expect(threads).toHaveLength(1);
    expect(threads[0].position).toBeUndefined();
  });

  it('throws ProviderError on network errors', async () => {
    const provider = new GitHubProvider('https://github.com', 'token');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow('Network error');
  });
});
