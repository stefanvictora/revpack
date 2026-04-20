import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import type { ReviewTarget, ReviewThread, ReviewDiff, ReviewVersion } from '../core/types.js';

const makeTarget = (): ReviewTarget => ({
  provider: 'gitlab',
  repository: 'group/project',
  targetType: 'merge_request',
  targetId: '42',
  title: 'Test MR',
  description: 'A test merge request',
  author: 'alice',
  state: 'opened',
  sourceBranch: 'feature/test',
  targetBranch: 'main',
  webUrl: 'https://gitlab.example.com/group/project/-/merge_requests/42',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  labels: [],
  diffRefs: { baseSha: 'aaa', headSha: 'bbb', startSha: 'aaa' },
});

const makeThread = (): ReviewThread => ({
  provider: 'gitlab',
  targetRef: {
    provider: 'gitlab',
    repository: 'group/project',
    targetType: 'merge_request',
    targetId: '42',
  },
  threadId: 'thread-abc',
  resolved: false,
  resolvable: true,
  position: { filePath: 'src/app.ts', newLine: 10 },
  comments: [
    {
      id: 'note-1',
      body: 'Fix this null check',
      author: 'bob',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      origin: 'human',
      system: false,
    },
  ],
});

const makeDiff = (): ReviewDiff => ({
  oldPath: 'src/app.ts',
  newPath: 'src/app.ts',
  diff: '@@ -1,3 +1,4 @@\n import { foo } from "bar";\n+import { baz } from "qux";\n',
  newFile: false,
  renamedFile: false,
  deletedFile: false,
});

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'review-assist-test-'));
    manager = new WorkspaceManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('creates bundle directory structure', async () => {
    const bundle = await manager.createBundle(makeTarget(), [makeThread()], [makeDiff()], [], tmpDir);

    expect(bundle.sessionId).toBeTruthy();
    expect(bundle.target.targetId).toBe('42');
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.diffs).toHaveLength(1);

    // Verify directory structure
    const bundleDir = path.join(tmpDir, '.review-assist');
    const entries = await fs.readdir(bundleDir);
    expect(entries).toContain('session.json');
    expect(entries).toContain('target.json');
    expect(entries).toContain('threads');
    expect(entries).toContain('diffs');
    expect(entries).toContain('files');
    expect(entries).toContain('instructions');
    expect(entries).toContain('outputs');
  });

  it('writes session.json with correct structure', async () => {
    await manager.createBundle(makeTarget(), [], [], [], tmpDir);

    const sessionPath = path.join(tmpDir, '.review-assist', 'session.json');
    const session = JSON.parse(await fs.readFile(sessionPath, 'utf-8'));

    expect(session).toHaveProperty('id');
    expect(session).toHaveProperty('createdAt');
    expect(session.targetRef).toBeDefined();
  });

  it('writes target.json', async () => {
    await manager.createBundle(makeTarget(), [], [], [], tmpDir);

    const targetPath = path.join(tmpDir, '.review-assist', 'target.json');
    const target = JSON.parse(await fs.readFile(targetPath, 'utf-8'));

    expect(target.targetId).toBe('42');
    expect(target.title).toBe('Test MR');
  });

  it('writes thread JSON and markdown files', async () => {
    await manager.createBundle(makeTarget(), [makeThread()], [], [], tmpDir);

    const threadDir = path.join(tmpDir, '.review-assist', 'threads');
    const files = await fs.readdir(threadDir);

    expect(files).toContain('T-001.json');
    expect(files).toContain('T-001.md');

    const threadJson = JSON.parse(await fs.readFile(path.join(threadDir, 'T-001.json'), 'utf-8'));
    expect(threadJson.threadId).toBe('thread-abc');

    const threadMd = await fs.readFile(path.join(threadDir, 'T-001.md'), 'utf-8');
    expect(threadMd).toContain('Thread thread-abc');
    expect(threadMd).toContain('Fix this null check');
    expect(threadMd).toContain('Unresolved');
  });

  it('writes latest.patch', async () => {
    await manager.createBundle(makeTarget(), [], [makeDiff()], [], tmpDir);

    const patchPath = path.join(tmpDir, '.review-assist', 'diffs', 'latest.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');

    expect(patch).toContain('diff --git');
    expect(patch).toContain('src/app.ts');
  });

  it('writes output files', async () => {
    await manager.createBundle(makeTarget(), [], [], [], tmpDir);
    const outputPath = await manager.writeOutput('test.md', '# Test');

    expect(outputPath).toContain('outputs');
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toBe('# Test');
  });

  it('loads session from disk', async () => {
    await manager.createBundle(makeTarget(), [], [], [], tmpDir);
    const session = await manager.loadSession();

    expect(session).toBeTruthy();
    expect(session!.targetRef.targetId).toBe('42');
  });

  it('returns null when no session exists', async () => {
    const session = await manager.loadSession();
    expect(session).toBeNull();
  });
});
