import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  assertPublishMaterialUnchanged,
  clearPublishedDocument,
  loadPublishMaterial,
  removePublishedDrafts,
} from './publish-material.js';

describe('publish material workspace model', () => {
  let workingDir: string;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-publish-material-'));
    await fs.mkdir(path.join(workingDir, '.revpack'), { recursive: true });
    await fs.writeFile(
      path.join(workingDir, '.revpack', 'bundle.json'),
      JSON.stringify({
        target: { provider: 'gitlab', diffRefs: { headSha: 'abc1234' } },
        prepare: {
          checkpoint: { headSha: 'abc1234' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
        threads: { items: [] },
        outputs: {
          summary: { path: '.revpack/outputs/summary.md' },
          review: { path: '.revpack/outputs/note.md' },
        },
        publishedActions: [],
      }),
      'utf-8',
    );
  });

  afterEach(async () => {
    await fs.rm(workingDir, { recursive: true, force: true });
  });

  it('represents missing default draft files as empty material', async () => {
    const material = await loadPublishMaterial(workingDir);

    expect(material.findings).toEqual([]);
    expect(material.replies).toEqual([]);
    expect(material.summary).toMatchObject({ state: 'empty', content: '' });
    expect(material.note).toMatchObject({ state: 'empty', content: '' });
    expect(material.checkpointState).toBe('current');
  });

  it.each(['summary', 'review'] as const)(
    'rejects an absolute bundle-controlled %s output path before reading it',
    async (output) => {
      const outsidePath = path.join(workingDir, `${output}-outside.md`);
      await fs.writeFile(outsidePath, 'must not be read or removed', 'utf-8');
      const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
      const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
      bundle.outputs[output].path = outsidePath;
      await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');

      await expect(loadPublishMaterial(workingDir)).rejects.toThrow(
        /must be a relative path under \.revpack[\\/]outputs/,
      );
      await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('must not be read or removed');
    },
  );

  it.each(['summary', 'review'] as const)(
    'rejects a traversing bundle-controlled %s output path before reading it',
    async (output) => {
      const outsidePath = path.join(workingDir, 'outside.md');
      await fs.writeFile(outsidePath, 'must remain outside the bundle', 'utf-8');
      const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
      const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
      bundle.outputs[output].path = '.revpack/outputs/../../outside.md';
      await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');

      await expect(loadPublishMaterial(workingDir)).rejects.toThrow(/must not contain parent-directory traversal/);
      await expect(fs.readFile(outsidePath, 'utf-8')).resolves.toBe('must remain outside the bundle');
    },
  );

  it('rejects an output path that escapes through an existing symlink before reading it', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const outsideDir = path.join(workingDir, 'outside-outputs');
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'summary.md'), 'outside summary', 'utf-8');
    try {
      await fs.symlink(outsideDir, path.join(outputsDir, 'escape'), 'junction');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') return;
      throw error;
    }

    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.outputs.summary.path = '.revpack/outputs/escape/summary.md';
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');

    await expect(loadPublishMaterial(workingDir)).rejects.toThrow(
      /Summary output path resolves outside \.revpack[\\/]outputs through an existing symlink/,
    );
  });

  it('rejects schema-invalid replies before material can be selected', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(
      path.join(outputsDir, 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Draft reply without resolve state' }]),
      'utf-8',
    );

    await expect(loadPublishMaterial(workingDir)).rejects.toThrow(/\.revpack[\\/]outputs[\\/]replies\.json.*resolve/s);
  });

  it('keeps original reply indexes and raw entries for selective persistence', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const replies = [
      { threadId: 'T-001', body: 'First reply', resolve: false, futureField: 'preserve me' },
      { threadId: 'T-002', body: 'Second reply', resolve: true },
    ];
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(path.join(outputsDir, 'replies.json'), JSON.stringify(replies), 'utf-8');

    const material = await loadPublishMaterial(workingDir);

    expect(material.replies.map(({ index, value }) => ({ index, threadId: value.threadId }))).toEqual([
      { index: 0, threadId: 'T-001' },
      { index: 1, threadId: 'T-002' },
    ]);
    expect(material.replies[0].raw).toEqual(replies[0]);
  });

  it('loads only schema-valid findings with valid positional anchors', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const diffsDir = path.join(workingDir, '.revpack', 'diffs');
    const finding = {
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      newLine: 2,
      body: 'Audit failures are not handled.',
      severity: 'high',
      category: 'correctness',
      futureField: 'preserve me',
    };
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.mkdir(diffsDir, { recursive: true });
    await fs.writeFile(
      path.join(diffsDir, 'latest.patch'),
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1,2 @@',
        ' const value = read();',
        '+audit(value);',
        '',
      ].join('\n'),
      'utf-8',
    );
    await fs.writeFile(path.join(outputsDir, 'new-findings.json'), JSON.stringify([finding]), 'utf-8');

    const material = await loadPublishMaterial(workingDir);

    expect(material.findings).toHaveLength(1);
    expect(material.findings[0]).toMatchObject({ index: 0, value: { severity: 'high', newLine: 2 } });
    expect(material.findings[0].raw).toEqual(finding);
  });

  it('removes successful original indexes while preserving deferred replies in order', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const replies = [
      { threadId: 'T-001', body: 'First reply', resolve: false, futureField: 'first' },
      { threadId: 'T-002', body: 'Second reply', resolve: true, futureField: 'published' },
      { threadId: 'T-003', body: 'Third reply', resolve: false, futureField: 'third' },
    ];
    await fs.mkdir(outputsDir, { recursive: true });
    const repliesPath = path.join(outputsDir, 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);

    await removePublishedDrafts(material.repliesPath, material.replies, new Set([1]), {
      deleteWhenEmpty: true,
    });

    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual([replies[0], replies[2]]);
  });

  it('preserves the original queue and cleans its temporary file when atomic replacement fails', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const replies = [
      { threadId: 'T-001', body: 'Keep this reply', resolve: false },
      { threadId: 'T-002', body: 'Published reply', resolve: true },
    ];
    const original = JSON.stringify(replies, null, 2);
    await fs.mkdir(outputsDir, { recursive: true });
    const repliesPath = path.join(outputsDir, 'replies.json');
    await fs.writeFile(repliesPath, original, 'utf-8');

    vi.resetModules();
    vi.doMock('node:fs/promises', async () => {
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      return { ...actual, rename: vi.fn().mockRejectedValue(new Error('injected rename failure')) };
    });
    try {
      const { removePublishedDrafts: removeWithRenameFailure } = await import('./publish-material.js');
      const drafts = replies.map((value, index) => ({ index, value, raw: value }));

      await expect(
        removeWithRenameFailure(repliesPath, drafts, new Set([1]), { deleteWhenEmpty: true }),
      ).rejects.toThrow('injected rename failure');
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    await expect(fs.readFile(repliesPath, 'utf-8')).resolves.toBe(original);
    await expect(fs.readdir(outputsDir)).resolves.toEqual(['replies.json']);
  });

  it('does not rewrite a queue that changed after its expected entries were loaded', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const replies = [
      { threadId: 'T-001', body: 'Deferred reply', resolve: false },
      { threadId: 'T-002', body: 'Selected reply', resolve: true },
    ];
    await fs.mkdir(outputsDir, { recursive: true });
    const repliesPath = path.join(outputsDir, 'replies.json');
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    const newerReplies = [...replies, { threadId: 'T-003', body: 'New concurrent draft', resolve: false }];
    await fs.writeFile(repliesPath, JSON.stringify(newerReplies), 'utf-8');

    await expect(
      removePublishedDrafts(material.repliesPath, material.replies, new Set([1]), {
        deleteWhenEmpty: true,
        expectedEntries: material.replies.map((draft) => draft.raw),
      }),
    ).rejects.toThrow(/replies\.json changed after publish material was loaded/);
    await expect(fs.readFile(repliesPath, 'utf-8').then(JSON.parse)).resolves.toEqual(newerReplies);
  });

  it('does not clear a document whose content changed after it was loaded', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    await fs.mkdir(outputsDir, { recursive: true });
    const notePath = path.join(outputsDir, 'note.md');
    await fs.writeFile(notePath, 'Selected review note', 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    await fs.writeFile(notePath, 'New concurrent review note', 'utf-8');

    await expect(clearPublishedDocument(notePath, material.note.content)).rejects.toThrow(
      /note\.md changed after publish material was loaded/,
    );
    await expect(fs.readFile(notePath, 'utf-8')).resolves.toBe('New concurrent review note');
  });

  it('rejects a changed selected queue when publish material is checked after confirmation', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const repliesPath = path.join(outputsDir, 'replies.json');
    const replies = [{ threadId: 'T-001', body: 'Selected reply', resolve: false }];
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(repliesPath, JSON.stringify(replies), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    await fs.writeFile(
      repliesPath,
      JSON.stringify([...replies, { threadId: 'T-002', body: 'New concurrent reply', resolve: false }]),
      'utf-8',
    );

    await expect(
      assertPublishMaterialUnchanged(material, {
        replyIndexes: [0],
        findingIndexes: [],
        summary: false,
        note: false,
        checkpoint: false,
      }),
    ).rejects.toThrow(/replies\.json changed after publish material was loaded.*Reopen Guided Publish/s);
  });

  it('rejects changed selected findings material when checked after confirmation', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const diffsDir = path.join(workingDir, '.revpack', 'diffs');
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.mkdir(diffsDir, { recursive: true });
    await fs.writeFile(
      path.join(diffsDir, 'latest.patch'),
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1 +1,2 @@',
        ' const value = read();',
        '+audit(value);',
        '',
      ].join('\n'),
      'utf-8',
    );
    const findingsPath = path.join(outputsDir, 'new-findings.json');
    const finding = {
      oldPath: 'src/app.ts',
      newPath: 'src/app.ts',
      newLine: 2,
      body: 'Selected finding',
      severity: 'high',
      category: 'correctness',
    };
    await fs.writeFile(findingsPath, JSON.stringify([finding]), 'utf-8');
    const material = await loadPublishMaterial(workingDir);
    await fs.writeFile(findingsPath, JSON.stringify([{ ...finding, body: 'Concurrent finding edit' }]), 'utf-8');

    await expect(
      assertPublishMaterialUnchanged(material, {
        replyIndexes: [],
        findingIndexes: [0],
        summary: false,
        note: false,
        checkpoint: false,
      }),
    ).rejects.toThrow(/new-findings\.json changed after publish material was loaded.*Reopen Guided Publish/s);
  });

  it.each(['summary', 'note'] as const)(
    'rejects changed selected %s material when checked after confirmation',
    async (kind) => {
      const outputsDir = path.join(workingDir, '.revpack', 'outputs');
      await fs.mkdir(outputsDir, { recursive: true });
      const changedPath = path.join(outputsDir, kind === 'summary' ? 'summary.md' : 'note.md');
      await fs.writeFile(changedPath, `Selected ${kind}`, 'utf-8');
      const material = await loadPublishMaterial(workingDir);
      await fs.writeFile(changedPath, `Concurrent ${kind} edit`, 'utf-8');

      await expect(
        assertPublishMaterialUnchanged(material, {
          replyIndexes: [],
          findingIndexes: [],
          summary: kind === 'summary',
          note: kind === 'note',
          checkpoint: false,
        }),
      ).rejects.toThrow(
        new RegExp(`${kind}\\.md changed after publish material was loaded.*Reopen Guided Publish`, 's'),
      );
    },
  );

  it('loads matching active or resolved thread context for reply previews', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const threadsDir = path.join(workingDir, '.revpack', 'resolved-threads');
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.mkdir(threadsDir, { recursive: true });
    await fs.writeFile(
      path.join(outputsDir, 'replies.json'),
      JSON.stringify([{ threadId: 'T-001', body: 'Reply draft', resolve: true }]),
      'utf-8',
    );
    const bundlePath = path.join(workingDir, '.revpack', 'bundle.json');
    const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf-8'));
    bundle.threads.items = [
      {
        shortId: 'T-001',
        providerThreadId: 'provider-thread-1',
        file: '.revpack/resolved-threads/T-001.json',
        resolved: true,
      },
    ];
    await fs.writeFile(bundlePath, JSON.stringify(bundle), 'utf-8');
    await fs.writeFile(
      path.join(threadsDir, 'T-001.json'),
      JSON.stringify({
        provider: 'gitlab',
        targetRef: { provider: 'gitlab', repository: 'group/project', targetType: 'merge_request', targetId: '1' },
        threadId: 'provider-thread-1',
        resolved: true,
        resolvable: true,
        comments: [
          {
            id: 'comment-1',
            body: 'Original concern',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      }),
      'utf-8',
    );

    const material = await loadPublishMaterial(workingDir);

    expect(material.replyContexts.get(0)).toMatchObject({
      threadId: 'provider-thread-1',
      resolved: true,
      comments: [{ body: 'Original concern' }],
    });
  });

  it.each([
    ['replies.json', '{not json', /must contain valid JSON/],
    ['new-findings.json', '{}', /must be a JSON array/],
    ['new-findings.json', '[{}]', /schema-invalid findings/],
  ])('rejects invalid default queue material in %s', async (filename, content, expected) => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    await fs.mkdir(outputsDir, { recursive: true });
    await fs.writeFile(path.join(outputsDir, filename), content, 'utf-8');

    await expect(loadPublishMaterial(workingDir)).rejects.toThrow(expected);
  });

  it('surfaces queue read errors instead of treating them as empty', async () => {
    await fs.mkdir(path.join(workingDir, '.revpack', 'outputs', 'replies.json'), { recursive: true });

    await expect(loadPublishMaterial(workingDir)).rejects.toThrow(/Could not read .*replies\.json/);
  });

  it('does not rewrite a queue when no published indexes are removed', async () => {
    const outputsDir = path.join(workingDir, '.revpack', 'outputs');
    const original = '[ { "threadId": "T-001", "body": "Keep formatting", "resolve": false } ]\n';
    await fs.mkdir(outputsDir, { recursive: true });
    const repliesPath = path.join(outputsDir, 'replies.json');
    await fs.writeFile(repliesPath, original, 'utf-8');
    const material = await loadPublishMaterial(workingDir);

    await expect(
      removePublishedDrafts(repliesPath, material.replies, new Set(), { deleteWhenEmpty: true }),
    ).resolves.toBe(false);
    await expect(fs.readFile(repliesPath, 'utf-8')).resolves.toBe(original);
  });
});
