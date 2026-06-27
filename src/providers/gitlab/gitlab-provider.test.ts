import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { GitLabProvider } from './gitlab-provider.js';
import type { ReviewThread } from '../../core/types.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe('GitLabProvider discussion mapping', () => {
  it('expands GitLab relative upload image URLs to project upload URLs', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'thread-1',
            notes: [
              {
                id: 1001,
                project_id: 83828498,
                body: '![image.png](/uploads/e24b36e3bd6737d206e1d1de43c03e58/image.png){width=735 height=165}',
                author: { username: 'alice' },
                created_at: '2026-06-27T10:08:58.874Z',
                updated_at: '2026-06-27T10:08:58.874Z',
                resolvable: true,
                resolved: false,
              },
            ],
          },
        ]),
        { headers: { 'x-total-pages': '1' } },
      ),
    );

    const provider = new GitLabProvider('https://gitlab.com', 'token');
    const threads = await provider.listAllThreads({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });

    expect(threads[0]?.comments[0]?.body).toBe(
      '![image.png](https://gitlab.com/-/project/83828498/uploads/e24b36e3bd6737d206e1d1de43c03e58/image.png){width=735 height=165}',
    );
  });

  it('leaves absolute URLs and unrelated relative links unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'thread-1',
            notes: [
              {
                id: 1001,
                body: [
                  '![absolute](https://example.com/uploads/file.png)',
                  '[relative docs](/docs/readme.md)',
                  '<img src="/uploads/hash/screenshot.png">',
                ].join('\n'),
                author: { username: 'alice' },
                created_at: '2026-06-27T10:08:58.874Z',
                updated_at: '2026-06-27T10:08:58.874Z',
              },
            ],
          },
        ]),
        { headers: { 'x-total-pages': '1' } },
      ),
    );

    const provider = new GitLabProvider('https://gitlab.example.com', 'token');
    const threads = await provider.listAllThreads({
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    });

    expect(threads[0]?.comments[0]?.body).toBe(
      [
        '![absolute](https://example.com/uploads/file.png)',
        '[relative docs](/docs/readme.md)',
        '<img src="https://gitlab.example.com/-/project/group%2Fproject/uploads/hash/screenshot.png">',
      ].join('\n'),
    );
  });
});

describe('GitLabProvider.localizeReviewAssets', () => {
  const threadWithUpload = (body: string): ReviewThread => ({
    provider: 'gitlab',
    targetRef: {
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '42',
    },
    threadId: 'thread-1',
    resolved: false,
    resolvable: true,
    comments: [
      {
        id: 'note-1',
        body,
        author: 'alice',
        createdAt: '2026-06-27T10:08:58.874Z',
        updatedAt: '2026-06-27T10:08:58.874Z',
        origin: 'human',
        system: false,
      },
    ],
  });

  it('downloads GitLab upload assets and returns Markdown rewrites', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      const remoteUrl = 'https://gitlab.com/-/project/83828498/uploads/e24b36/image.png';
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload(`![image.png](${remoteUrl})`)],
        { assetDir: tmpDir, markdownPathPrefix: '../assets' },
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://gitlab.com/api/v4/projects/83828498/uploads/e24b36/image.png',
        expect.objectContaining({
          headers: { 'PRIVATE-TOKEN': 'token' },
        }),
      );
      expect(rewrites).toEqual({
        [remoteUrl]: '../assets/gitlab-uploads/83828498/e24b36/image.png',
      });
      await expect(
        fs.readFile(path.join(tmpDir, 'gitlab-uploads', '83828498', 'e24b36', 'image.png')),
      ).resolves.toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('keeps remote URLs when the upload download fails', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('missing', { status: 404 }));
      const onProgress = vi.fn();

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('![image.png](https://gitlab.com/-/project/83828498/uploads/e24b36/image.png)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets', onProgress },
      );

      expect(rewrites).toEqual({});
      expect(onProgress).toHaveBeenCalledWith(
        expect.stringContaining('Could not download GitLab review comment asset'),
      );
      expect(onProgress).not.toHaveBeenCalledWith(expect.stringContaining('Markdown Upload / Read'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('prints a concrete GitLab permission hint when upload downloads are forbidden', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('forbidden', { status: 403 }));
      const onProgress = vi.fn();

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('![image.png](https://gitlab.com/-/project/83828498/uploads/e24b36/image.png)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets', onProgress },
      );

      expect(rewrites).toEqual({});
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Markdown Upload / Read'));
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('Guest or higher'));
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('GET /projects/:id/uploads/:secret/:filename'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('only downloads image embeds, not ordinary upload links', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('[download](https://gitlab.com/-/project/83828498/uploads/e24b36/file.png)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets' },
      );

      expect(rewrites).toEqual({});
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported upload image extensions before downloading', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<svg></svg>'));
      const onProgress = vi.fn();

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('![diagram](https://gitlab.com/-/project/83828498/uploads/e24b36/diagram.svg)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets', onProgress },
      );

      expect(rewrites).toEqual({});
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('unsupported image file extension .svg'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects unsupported upload response content types', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('alert(1)', { headers: { 'content-type': 'application/javascript' } }),
      );
      const onProgress = vi.fn();

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('![image.png](https://gitlab.com/-/project/83828498/uploads/e24b36/image.png)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets', onProgress },
      );

      expect(rewrites).toEqual({});
      expect(onProgress).toHaveBeenCalledWith(
        expect.stringContaining('unsupported content type application/javascript'),
      );
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('allows GitLab image uploads served as generic binary content', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      const remoteUrl = 'https://gitlab.com/-/project/83828498/uploads/e24b36/image.png';
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'application/octet-stream' } }),
      );

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload(`![image.png](${remoteUrl})`)],
        { assetDir: tmpDir, markdownPathPrefix: '../assets' },
      );

      expect(rewrites).toEqual({
        [remoteUrl]: '../assets/gitlab-uploads/83828498/e24b36/image.png',
      });
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects upload images larger than the download limit', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-gitlab-assets-'));
    try {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(null, {
          headers: {
            'content-length': String(11 * 1024 * 1024),
            'content-type': 'image/png',
          },
        }),
      );
      const onProgress = vi.fn();

      const provider = new GitLabProvider('https://gitlab.com', 'token');
      const rewrites = await provider.localizeReviewAssets(
        {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
        },
        [threadWithUpload('![image.png](https://gitlab.com/-/project/83828498/uploads/e24b36/image.png)')],
        { assetDir: tmpDir, markdownPathPrefix: '../assets', onProgress },
      );

      expect(rewrites).toEqual({});
      expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('asset is larger than 10 MiB'));
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
