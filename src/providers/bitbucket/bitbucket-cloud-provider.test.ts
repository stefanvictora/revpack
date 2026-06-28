import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthenticationError, ProviderError } from '../../core/errors.js';
import type { ReviewTargetRef } from '../../core/types.js';
import { BitbucketCloudProvider } from './bitbucket-cloud-provider.js';

const ref: ReviewTargetRef = {
  provider: 'bitbucket-cloud',
  repository: 'workspace/repo',
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

function pullRequest(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 42,
    title: 'Add Bitbucket support',
    description: 'PR body',
    summary: { raw: 'Summary body' },
    state: 'OPEN',
    author: { display_name: 'Alice Example', nickname: 'alice', account_id: 'abc123' },
    source: {
      branch: { name: 'feature/bitbucket' },
      commit: { hash: 'head-sha' },
      repository: { full_name: 'workspace/repo' },
    },
    destination: {
      branch: { name: 'main' },
      commit: { hash: 'base-sha' },
      repository: { full_name: 'workspace/repo' },
    },
    links: { html: { href: 'https://bitbucket.org/workspace/repo/pull-requests/42' } },
    created_on: '2026-01-01T00:00:00.000000+00:00',
    updated_on: '2026-01-02T00:00:00.000000+00:00',
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

function requestBodyJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== 'string') throw new Error('Expected request body to be a string');
  return JSON.parse(init.body);
}

describe('BitbucketCloudProvider.resolveTarget', () => {
  const provider = new BitbucketCloudProvider('user@example.com', 'api-token');

  it('parses Bitbucket Cloud pull request URLs', () => {
    expect(provider.resolveTarget('https://bitbucket.org/workspace/repo/pull-requests/42')).toEqual(ref);
    expect(provider.resolveTarget('http://bitbucket.org/workspace/repo/pull-requests/42')).toEqual(ref);
    expect(provider.resolveTarget('https://bitbucket.org/workspace/repo/pull-requests/42/')).toEqual(ref);
    expect(provider.resolveTarget('https://bitbucket.org/workspace/repo/pull-requests/42?tab=diff')).toEqual(ref);
    expect(provider.resolveTarget('https://bitbucket.org/workspace/repo/pull-requests/42#comment-1')).toEqual(ref);
  });

  it('parses compact refs without changing persisted target ids', () => {
    expect(provider.resolveTarget('#42')).toEqual({ ...ref, repository: '' });
    expect(provider.resolveTarget('42')).toEqual({ ...ref, repository: '' });
    expect(provider.resolveTarget('workspace/repo#42')).toEqual(ref);
    expect(provider.resolveTarget('workspace/repo/pull-requests/42')).toEqual(ref);
  });

  it('rejects Bitbucket Server/Data Center-style URLs clearly', () => {
    expect(() =>
      provider.resolveTarget('https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/42'),
    ).toThrow(ProviderError);
    expect(() =>
      provider.resolveTarget('https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/42'),
    ).toThrow('Bitbucket Server/Data Center pull request URLs are not supported');
    expect(() =>
      provider.resolveTarget('https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/42/overview'),
    ).toThrow('Bitbucket Server/Data Center pull request URLs are not supported');
    expect(() =>
      provider.resolveTarget('https://bitbucket.example.com/projects/PROJ/repos/repo/pull-requests/42/diff?until=abc'),
    ).toThrow('Bitbucket Server/Data Center pull request URLs are not supported');
  });

  it('rejects unparseable refs', () => {
    expect(() => provider.resolveTarget('not-a-ref')).toThrow('Cannot parse Bitbucket Cloud target reference');
    expect(() => provider.resolveTarget('workspace/repo#42suffix')).toThrow(
      'Cannot parse Bitbucket Cloud target reference',
    );
    expect(() => provider.resolveTarget('workspace/repo/pull-requests/42/files')).toThrow(
      'Cannot parse Bitbucket Cloud target reference',
    );
    expect(() => provider.resolveTarget('42suffix')).toThrow('Cannot parse Bitbucket Cloud target reference');
  });
});

describe('BitbucketCloudProvider target reads', () => {
  let provider: BitbucketCloudProvider;

  beforeEach(() => {
    provider = new BitbucketCloudProvider('user@example.com', 'api-token');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('maps pull request snapshots to provider-neutral targets', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/42');
      expect(init?.headers).toMatchObject({
        Authorization: `Basic ${Buffer.from('user@example.com:api-token').toString('base64')}`,
      });
      return jsonResponse(pullRequest());
    });

    await expect(provider.getTargetSnapshot(ref)).resolves.toEqual({
      provider: 'bitbucket-cloud',
      repository: 'workspace/repo',
      targetType: 'pull_request',
      targetId: '42',
      title: 'Add Bitbucket support',
      description: 'PR body',
      author: 'alice',
      state: 'OPEN',
      sourceBranch: 'feature/bitbucket',
      targetBranch: 'main',
      webUrl: 'https://bitbucket.org/workspace/repo/pull-requests/42',
      createdAt: '2026-01-01T00:00:00.000000+00:00',
      updatedAt: '2026-01-02T00:00:00.000000+00:00',
      labels: [],
      diffRefs: {
        baseSha: 'base-sha',
        headSha: 'head-sha',
        startSha: 'base-sha',
      },
    });
  });

  it('expands abbreviated pull request commit hashes for snapshots', async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      if (url.endsWith('/commit/0731551ad420')) {
        return jsonResponse({ type: 'commit', hash: '0731551ad42031e97ee04a34c7fe40e3bd906833' });
      }
      if (url.endsWith('/commit/fb0aebbd3d5b')) {
        return jsonResponse({ type: 'commit', hash: 'fb0aebbd3d5b858c6024745659c9f4211d186589' });
      }
      return jsonResponse(
        pullRequest({
          source: {
            branch: { name: 'pr-test' },
            commit: { hash: 'fb0aebbd3d5b' },
            repository: { full_name: 'workspace/repo' },
          },
          destination: {
            branch: { name: 'main' },
            commit: { hash: '0731551ad420' },
            repository: { full_name: 'workspace/repo' },
          },
        }),
      );
    });

    const target = await provider.getTargetSnapshot(ref);

    expect(target.diffRefs).toEqual({
      baseSha: '0731551ad42031e97ee04a34c7fe40e3bd906833',
      headSha: 'fb0aebbd3d5b858c6024745659c9f4211d186589',
      startSha: '0731551ad42031e97ee04a34c7fe40e3bd906833',
    });
    expect(urls).toEqual([
      'https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/42',
      'https://api.bitbucket.org/2.0/repositories/workspace/repo/commit/0731551ad420',
      'https://api.bitbucket.org/2.0/repositories/workspace/repo/commit/fb0aebbd3d5b',
    ]);
  });

  it('falls back across nullable description, author, and URL fields', async () => {
    installFetch(() =>
      jsonResponse(
        pullRequest({
          description: null,
          author: { display_name: 'Display Name', nickname: null, account_id: 'account-id' },
          links: null,
        }),
      ),
    );

    const target = await provider.getTargetSnapshot(ref);
    expect(target.description).toBe('Summary body');
    expect(target.author).toBe('Display Name');
    expect(target.webUrl).toBe('https://bitbucket.org/workspace/repo/pull-requests/42');
  });

  it('marks fork pull requests with headRepository', async () => {
    installFetch(() =>
      jsonResponse(
        pullRequest({
          source: {
            branch: { name: 'feature/fork' },
            commit: { hash: 'fork-head' },
            repository: { full_name: 'contributor/repo' },
          },
        }),
      ),
    );

    const target = await provider.getTargetSnapshot(ref);
    expect(target.headRepository).toBe('contributor/repo');
    expect(target.sourceBranch).toBe('feature/fork');
  });

  it('lists open pull requests and supports source-branch lookup', async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      return jsonResponse({ values: [pullRequest({ id: 1 })] });
    });

    await expect(provider.listOpenReviewTargets('workspace/repo')).resolves.toHaveLength(1);
    await expect(provider.findTargetByBranch('workspace/repo', 'feature/bitbucket')).resolves.toHaveLength(1);

    expect(urls[0]).toBe(
      'https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests?state=OPEN&pagelen=50',
    );
    expect(urls[1]).toContain('state=OPEN');
    expect(urls[1]).toContain('q=source.branch.name');
  });

  it('follows Bitbucket pagination links', async () => {
    installFetch((url) => {
      if (url.includes('page=2')) return jsonResponse({ values: [pullRequest({ id: 2 })] });
      return jsonResponse({
        values: [pullRequest({ id: 1 })],
        next: 'https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests?page=2',
      });
    });

    const targets = await provider.listOpenReviewTargets('workspace/repo');
    expect(targets.map((target) => target.targetId)).toEqual(['1', '2']);
  });

  it('uses pull request head metadata as the synthetic diff version', async () => {
    const urls: string[] = [];
    installFetch((url) => {
      urls.push(url);
      if (url.endsWith('/commit/0731551ad420')) {
        return jsonResponse({ type: 'commit', hash: '0731551ad42031e97ee04a34c7fe40e3bd906833' });
      }
      if (url.endsWith('/commit/fb0aebbd3d5b')) {
        return jsonResponse({ type: 'commit', hash: 'fb0aebbd3d5b858c6024745659c9f4211d186589' });
      }
      return jsonResponse(pullRequest());
    });

    await expect(provider.getDiffVersions(ref)).resolves.toEqual([
      {
        provider: 'bitbucket-cloud',
        targetRef: ref,
        versionId: 'head-sha',
        headCommitSha: 'head-sha',
        baseCommitSha: 'base-sha',
        startCommitSha: 'base-sha',
        createdAt: '2026-01-02T00:00:00.000000+00:00',
      },
    ]);
    expect(urls).toEqual(['https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/42']);
    expect(urls.some((url) => url.includes('/diffstat'))).toBe(false);
    expect(urls.some((url) => url.endsWith('/patch'))).toBe(false);
  });

  it('updates pull request descriptions through the pullrequests API', async () => {
    installFetch((url, init) => {
      expect(url).toBe('https://api.bitbucket.org/2.0/repositories/workspace/repo/pullrequests/42');
      expect(init?.method).toBe('PUT');
      expect(requestBodyJson(init)).toEqual({ description: 'new body' });
      return jsonResponse(pullRequest({ description: 'new body' }));
    });

    await provider.updateDescription(ref, 'new body');
  });
});

describe('BitbucketCloudProvider errors and clone URLs', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses HTTPS and SSH Bitbucket Cloud clone URLs', () => {
    expect(new BitbucketCloudProvider('email', 'token').getCloneUrl('workspace/repo')).toBe(
      'https://bitbucket.org/workspace/repo.git',
    );
    expect(new BitbucketCloudProvider('email', 'token', { sshClone: true }).getCloneUrl('workspace/repo')).toBe(
      'git@bitbucket.org:workspace/repo.git',
    );
  });

  it('throws actionable authentication and not-found errors without leaking credentials', async () => {
    const provider = new BitbucketCloudProvider('secret-email@example.com', 'secret-token');
    installFetch(() => jsonResponse({ error: { message: 'denied' } }, { status: 401, statusText: 'Unauthorized' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow(AuthenticationError);
    await expect(provider.getTargetSnapshot(ref)).rejects.not.toThrow('secret-token');

    installFetch(() => jsonResponse({ error: { message: 'forbidden' } }, { status: 403, statusText: 'Forbidden' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow(ProviderError);
    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow('repository permissions and token scopes');

    installFetch(() => jsonResponse({ error: { message: 'missing' } }, { status: 404, statusText: 'Not Found' }));

    await expect(provider.getTargetSnapshot(ref)).rejects.toThrow('resource not found or inaccessible');
    await expect(provider.getTargetSnapshot(ref)).rejects.not.toThrow('secret-email@example.com');
  });

  it('throws unsupported errors for review comment operations not covered by target support', async () => {
    const provider = new BitbucketCloudProvider('email', 'token');

    await expect(provider.createNote(ref, 'body')).rejects.toThrow('Bitbucket Cloud review notes is not supported yet');
    await expect(provider.postReply(ref, 'thread-1', 'body')).rejects.toThrow(
      'Bitbucket Cloud reply publishing is not supported yet',
    );
    await expect(provider.resolveThread(ref, 'thread-1')).rejects.toThrow(
      'Bitbucket Cloud thread resolution is not supported yet',
    );
    await expect(provider.createThread(ref, 'body')).rejects.toThrow(
      'Bitbucket Cloud inline review comments is not supported yet',
    );
    await expect(provider.updateNote(ref, 'note-1', 'body')).rejects.toThrow(
      'Bitbucket Cloud review notes is not supported yet',
    );
    await expect(provider.listAllThreads(ref)).resolves.toEqual([]);
    await expect(provider.listUnresolvedThreads(ref)).resolves.toEqual([]);
    await expect(provider.findNoteByMarker(ref, '<!-- revpack')).resolves.toBeNull();
  });
});
