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
    head: { ref: 'feature/test', sha: 'head-sha' },
    base: { ref: 'main', sha: 'base-sha' },
    ...overrides,
  };
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
    });
  });

  it('lists open PRs and filters PRs by source branch', async () => {
    const pulls = [
      pr({ number: 1, head: { ref: 'feature/test', sha: 'one' } }),
      pr({ number: 2, head: { ref: 'other', sha: 'two' } }),
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

  it('maps paginated PR files to diffs', async () => {
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42/files') {
        return jsonResponse(
          [
            { filename: 'src/new.ts', status: 'added', patch: '@@ -0,0 +1 @@\n+new' },
            {
              filename: 'src/new-name.ts',
              previous_filename: 'src/old-name.ts',
              status: 'renamed',
              patch: '@@ -1 +1 @@\n-old\n+new',
            },
          ],
          {
            headers: {
              link: '<https://api.github.com/repos/octo/repo/pulls/42/files?page=2>; rel="next"',
            },
          },
        );
      }
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42/files?page=2') {
        return jsonResponse([{ filename: 'src/remove.ts', status: 'removed' }]);
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(provider.getLatestDiff(ref)).resolves.toEqual([
      {
        oldPath: 'src/new.ts',
        newPath: 'src/new.ts',
        diff: '@@ -0,0 +1 @@\n+new',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      },
      {
        oldPath: 'src/old-name.ts',
        newPath: 'src/new-name.ts',
        diff: '@@ -1 +1 @@\n-old\n+new',
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      },
      {
        oldPath: 'src/remove.ts',
        newPath: 'src/remove.ts',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      },
    ]);
  });

  it('uses the PR head SHA as the provider version and compares versions by commit SHA', async () => {
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/repos/octo/repo/compare/old-sha...head-sha') {
        return jsonResponse({ files: [{ filename: 'src/app.ts', status: 'modified', patch: '@@ -1 +1 @@' }] });
      }
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
    await expect(provider.getIncrementalDiff(ref, 'head-sha', 'head-sha')).resolves.toEqual([]);
    await expect(provider.getIncrementalDiff(ref, 'old-sha', 'head-sha')).resolves.toEqual([
      {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: '@@ -1 +1 @@',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
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
                              body: '<!-- revkit -->\nDone',
                              author: { login: 'revkit[bot]' },
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
            body: '<!-- revkit -->\nDone',
            author: 'revkit[bot]',
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
    installFetch((url) => {
      if (url === 'https://api.github.com/repos/octo/repo/pulls/42') return jsonResponse(pr());
      if (url === 'https://api.github.com/graphql') {
        return jsonResponse({ errors: [{ message: 'Validation failed: line must be part of the diff' }] });
      }
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments') {
        return jsonResponse({ id: 5001, body: 'fallback' });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(
      provider.createThread(ref, 'finding body', {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        newLine: 999,
      }),
    ).resolves.toBe('5001');
  });

  it('finds, creates, and updates PR timeline notes', async () => {
    const requests: { url: string; method?: string; body?: unknown }[] = [];
    installFetch((url, init) => {
      requests.push({ url, method: init?.method, body: init?.body ? requestBodyJson(init) : undefined });
      if (url === 'https://api.github.com/repos/octo/repo/issues/42/comments' && !init?.method) {
        return jsonResponse([
          { id: 1, body: 'hello' },
          { id: 2, body: '<!-- revkit:review -->\nstate' },
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

    await expect(provider.findNoteByMarker(ref, '<!-- revkit:review -->')).resolves.toEqual({
      id: '2',
      body: '<!-- revkit:review -->\nstate',
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
});
