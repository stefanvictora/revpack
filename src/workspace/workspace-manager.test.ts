import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WorkspaceManager } from '../workspace/workspace-manager.js';
import type {
  ReviewTarget,
  ReviewThread,
  ReviewDiff,
  ReviewCommit,
  ReviewVersion,
  PrepareSummary,
  BundleLocal,
} from '../core/types.js';
import { computeContentHash } from './thread-digest.js';

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

const makeVersion = (versionId: string, createdAt: string): ReviewVersion => ({
  provider: 'gitlab',
  targetRef: {
    provider: 'gitlab',
    repository: 'group/project',
    targetType: 'merge_request',
    targetId: '42',
  },
  versionId,
  headCommitSha: 'bbb',
  baseCommitSha: 'aaa',
  startCommitSha: 'aaa',
  createdAt,
});

const makeCommit = (overrides: Partial<ReviewCommit> = {}): ReviewCommit => ({
  sha: '1111111111111111111111111111111111111111',
  shortSha: '1111111',
  authorName: 'Alice',
  authorDate: '2026-07-07',
  message: 'Add commit context\n\nExplain why this change exists.',
  ...overrides,
});

const makeStructuredDiff = (): ReviewDiff => ({
  oldPath: 'src/service.ts',
  newPath: 'src/service.ts',
  diff: [
    '@@ -10,4 +10,5 @@ function run()',
    ' const value = read();',
    '-oldCall(value);',
    '+newCall(value);',
    ' return value;',
    '+audit(value);',
  ].join('\n'),
  newFile: false,
  renamedFile: false,
  deletedFile: false,
});

describe('WorkspaceManager', () => {
  let tmpDir: string;
  let manager: WorkspaceManager;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-test-'));
    manager = new WorkspaceManager(tmpDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Helper: build index and create bundle in one call */
  async function createBundle(
    m: WorkspaceManager,
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[] = [],
    versions: ReviewVersion[] = [],
    commits: ReviewCommit[] = [],
  ) {
    const threadIndex = WorkspaceManager.buildThreadIndex(threads);
    return { bundle: await m.createBundle(target, threads, diffs, versions, threadIndex, { commits }), threadIndex };
  }

  function makeTargetForProvider(provider: ReviewTarget['provider']): ReviewTarget {
    const target = makeTarget();
    if (provider === 'github') {
      return {
        ...target,
        provider,
        repository: 'owner/repo',
        targetType: 'pull_request',
        webUrl: 'https://github.com/owner/repo/pull/42',
      };
    }
    if (provider === 'local') {
      return {
        ...target,
        provider,
        targetType: 'local_review',
        targetId: 'main...feature/test',
        webUrl: '',
      };
    }
    if (provider === 'bitbucket-cloud') {
      return {
        ...target,
        provider,
        repository: 'workspace/repo',
        targetType: 'pull_request',
        webUrl: 'https://bitbucket.org/workspace/repo/pull-requests/42',
      };
    }
    return target;
  }

  it('creates bundle directory structure', async () => {
    const { bundle } = await createBundle(manager, makeTarget(), [makeThread()], [makeDiff()]);

    expect(bundle.preparedAt).toBeTruthy();
    expect(bundle.target.targetId).toBe('42');
    expect(bundle.threads).toHaveLength(1);
    expect(bundle.diffs).toHaveLength(1);

    // Verify directory structure
    const bundleDir = path.join(tmpDir, '.revpack');
    const entries = await fs.readdir(bundleDir);
    expect(entries).toContain('description.md');
    expect(entries).toContain('threads');
    expect(entries).toContain('diffs');
    expect(entries).toContain('outputs');
    expect(entries).toContain('schemas');

    // Verify schema reference files are written outside the agent-writable output directory
    const outputEntries = await fs.readdir(path.join(bundleDir, 'outputs'));
    expect(outputEntries).not.toContain('new-findings.schema.json');
    expect(outputEntries).not.toContain('replies.schema.json');

    const newFindingsSchema = await fs.readFile(path.join(bundleDir, 'schemas', 'new-findings.schema.json'), 'utf-8');
    const repliesSchema = await fs.readFile(path.join(bundleDir, 'schemas', 'replies.schema.json'), 'utf-8');
    expect(newFindingsSchema).toContain('Array of review findings to publish as provider diff threads.');
    expect(newFindingsSchema).not.toContain('GitLab/GitHub');
    expect(repliesSchema).toContain('Internal disposition tag (not published to the provider).');
    expect(repliesSchema).not.toContain('not published to GitLab');
  });

  it('writeContext writes CONTEXT.md, INSTRUCTIONS.md and instructions/', async () => {
    const threads = [makeThread()];
    const { threadIndex } = await createBundle(manager, makeTarget(), threads, [makeDiff()]);

    await manager.writeContext(makeTarget(), threads, [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const entries = await fs.readdir(bundleDir);
    expect(entries).toContain('CONTEXT.md');
    expect(entries).not.toContain('AGENT_CONTRACT.md');
    expect(entries).toContain('INSTRUCTIONS.md');
    expect(entries).toContain('instructions');

    // Verify instruction sub-files
    const instrEntries = await fs.readdir(path.join(bundleDir, 'instructions'));
    expect(instrEntries).toContain('01-review-workflow-and-outputs.md');
    expect(instrEntries).toContain('02-thread-replies.md');
    expect(instrEntries).toContain('07-final-checks.md');

    const context = await fs.readFile(path.join(bundleDir, 'CONTEXT.md'), 'utf-8');
    const findingsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '03-new-findings-and-anchors.md'),
      'utf-8',
    );
    const finalChecks = await fs.readFile(path.join(bundleDir, 'instructions', '07-final-checks.md'), 'utf-8');
    expect(context).toContain('## Review Contract');
    expect(context).toContain('do not discard a valid, non-duplicate issue');
    expect(findingsInstructions).toContain('## Incremental review scope');
    expect(findingsInstructions).toContain('Looking up that record is a required input step');
    expect(finalChecks).toContain('no valid finding was removed solely because it is outside the checkpoint delta');
  });

  it('renders GitHub instruction templates with plain suggestion fences', async () => {
    const target = makeTargetForProvider('github');
    const { threadIndex } = await createBundle(manager, target, [], [makeDiff()]);

    await manager.writeContext(target, [], [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const findingsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '03-new-findings-and-anchors.md'),
      'utf-8',
    );
    const suggestionsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '04-suggestions-and-agent-handover.md'),
      'utf-8',
    );

    expect(findingsInstructions).toContain('```suggestion\n');
    expect(findingsInstructions).not.toContain('suggestion:-0+0');
    expect(suggestionsInstructions).toContain('```suggestion\n');
    expect(suggestionsInstructions).not.toContain('suggestion:-0+0');
    expect(suggestionsInstructions).not.toContain('suggestion:-1+2');
    expect(suggestionsInstructions).toContain('For GitHub, Bitbucket Cloud, and local reviews');
    expect(suggestionsInstructions).not.toContain('For GitHub and local reviews');
    expect(suggestionsInstructions).toContain('The fence stays plain `suggestion`');
    expect(findingsInstructions).toContain('<details>');
    expect(findingsInstructions).toContain('<summary>🤖 Prompt for AI Agents</summary>');
  });

  it('renders GitLab instruction templates with range-offset suggestion fences', async () => {
    const target = makeTargetForProvider('gitlab');
    const { threadIndex } = await createBundle(manager, target, [], [makeDiff()]);

    await manager.writeContext(target, [], [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const findingsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '03-new-findings-and-anchors.md'),
      'utf-8',
    );
    const suggestionsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '04-suggestions-and-agent-handover.md'),
      'utf-8',
    );

    expect(findingsInstructions).toContain('```suggestion:-0+0\n');
    expect(suggestionsInstructions).toContain('```suggestion:-0+0\n');
    expect(suggestionsInstructions).toContain('Use wider ranges only when the replacement needs neighboring lines.');
    expect(suggestionsInstructions).toContain('suggestion range (`-1+2`)');
  });

  it('renders local instruction templates with plain suggestion fences', async () => {
    const target = makeTargetForProvider('local');
    const { threadIndex } = await createBundle(manager, target, [], [makeDiff()]);

    await manager.writeContext(target, [], [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const suggestionsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '04-suggestions-and-agent-handover.md'),
      'utf-8',
    );

    expect(suggestionsInstructions).toContain('```suggestion\n');
    expect(suggestionsInstructions).not.toContain('suggestion:-0+0');
    expect(suggestionsInstructions).not.toContain('suggestion:-1+2');
  });

  it('renders Bitbucket handover prompts without HTML details', async () => {
    const target = makeTargetForProvider('bitbucket-cloud');
    const { threadIndex } = await createBundle(manager, target, [makeThread()], [makeDiff()]);

    await manager.writeContext(target, [makeThread()], [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const repliesInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '02-thread-replies.md'),
      'utf-8',
    );
    const findingsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '03-new-findings-and-anchors.md'),
      'utf-8',
    );
    const suggestionsInstructions = await fs.readFile(
      path.join(bundleDir, 'instructions', '04-suggestions-and-agent-handover.md'),
      'utf-8',
    );

    expect(repliesInstructions).toContain('#### 🤖 Prompt for AI Agents');
    expect(findingsInstructions).toContain('#### 🤖 Prompt for AI Agents');
    expect(suggestionsInstructions).toContain('#### 🤖 Prompt for AI Agents');
    expect(suggestionsInstructions).toContain('For GitHub, Bitbucket Cloud, and local reviews');
    expect(suggestionsInstructions).toContain('The fence stays plain `suggestion`');
    expect(suggestionsInstructions).not.toContain('For GitHub and local reviews');
    expect(suggestionsInstructions).not.toContain('suggestion:-0+0');
    expect(findingsInstructions).toContain('> Verify this issue against the current code');
    expect(`${repliesInstructions}\n${findingsInstructions}\n${suggestionsInstructions}`).not.toContain('<details>');
    expect(`${repliesInstructions}\n${findingsInstructions}\n${suggestionsInstructions}`).not.toContain('<summary>');
  });

  it('keeps generated instruction names as .md and still copies static instruction files', async () => {
    const target = makeTargetForProvider('github');
    const { threadIndex } = await createBundle(manager, target, [], [makeDiff()]);

    await manager.writeContext(target, [], [makeDiff()], threadIndex);

    const bundleDir = path.join(tmpDir, '.revpack');
    const instrEntries = await fs.readdir(path.join(bundleDir, 'instructions'));
    const finalChecks = await fs.readFile(path.join(bundleDir, 'instructions', '07-final-checks.md'), 'utf-8');

    expect(instrEntries).toContain('03-new-findings-and-anchors.md');
    expect(instrEntries).toContain('04-suggestions-and-agent-handover.md');
    expect(instrEntries).not.toContain('02-thread-replies.md.hbs');
    expect(instrEntries).not.toContain('03-new-findings-and-anchors.md.hbs');
    expect(instrEntries).not.toContain('04-suggestions-and-agent-handover.md.hbs');
    expect(finalChecks).toContain('no valid finding was removed solely because it is outside the checkpoint delta');
  });

  it('writes description.md with MR description', async () => {
    await createBundle(manager, makeTarget(), []);

    const descPath = path.join(tmpDir, '.revpack', 'description.md');
    const content = await fs.readFile(descPath, 'utf-8');

    expect(content).toContain('A test merge request');
  });

  it('writes commits.md with full commit messages when commits are available', async () => {
    await createBundle(manager, makeTarget(), [], [], [], [makeCommit()]);

    const content = await fs.readFile(path.join(tmpDir, '.revpack', 'commits.md'), 'utf-8');

    expect(content).toContain('# Commit List');
    expect(content).toContain('## 1111111 - Alice - 2026-07-07');
    expect(content).toContain('Add commit context\n\nExplain why this change exists.');
    expect(content).toContain('intent context only');
  });

  it('removes stale commits.md when the current bundle has no commits', async () => {
    await createBundle(manager, makeTarget(), [], [], [], [makeCommit()]);
    await createBundle(manager, makeTarget(), []);

    await expect(fs.readFile(path.join(tmpDir, '.revpack', 'commits.md'), 'utf-8')).rejects.toThrow();
  });

  it('writes thread JSON and markdown files', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const threadDir = path.join(tmpDir, '.revpack', 'threads');
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
    await createBundle(manager, makeTarget(), [], [makeDiff()]);

    const patchPath = path.join(tmpDir, '.revpack', 'diffs', 'latest.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');

    expect(patch).toContain('diff --git');
    expect(patch).toContain('src/app.ts');
  });

  it('writes structured diff artifacts', async () => {
    await createBundle(manager, makeTarget(), [], [makeStructuredDiff()]);

    const diffDir = path.join(tmpDir, '.revpack', 'diffs');
    const filesJson = JSON.parse(await fs.readFile(path.join(diffDir, 'files.json'), 'utf-8'));
    expect(filesJson.schemaVersion).toBe(2);
    expect(filesJson.files).toHaveLength(1);
    expect(filesJson.files[0]).toMatchObject({
      fileId: 'F001',
      status: 'modified',
      oldPath: 'src/service.ts',
      newPath: 'src/service.ts',
      added: 2,
      removed: 1,
      patchFile: 'patches/by-file/F001-service.patch',
      anchorMapFile: 'anchor-maps/F001-service.ndjson',
    });
    expect(filesJson.files[0]).not.toHaveProperty('hunks');

    const anchorMapLines = (await fs.readFile(path.join(diffDir, filesJson.files[0].anchorMapFile), 'utf-8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(anchorMapLines).toEqual([
      {
        kind: 'context',
        oldLine: 10,
        newLine: 10,
        text: 'const value = read();',
      },
      {
        kind: 'removed',
        oldLine: 11,
        text: 'oldCall(value);',
      },
      {
        kind: 'added',
        newLine: 11,
        text: 'newCall(value);',
      },
      {
        kind: 'context',
        oldLine: 12,
        newLine: 12,
        text: 'return value;',
      },
      {
        kind: 'added',
        newLine: 13,
        text: 'audit(value);',
      },
    ]);
    for (const record of anchorMapLines) {
      expect(record).not.toHaveProperty('fileId');
      expect(record).not.toHaveProperty('hunkId');
      expect(record).not.toHaveProperty('oldPath');
      expect(record).not.toHaveProperty('newPath');
      expect(Object.values(record)).not.toContain(null);
    }
    await expect(fs.access(path.join(diffDir, 'line-map.ndjson'))).rejects.toThrow();
    await expect(fs.access(path.join(diffDir, 'change-blocks.json'))).rejects.toThrow();
  });

  it('writes output files', async () => {
    await createBundle(manager, makeTarget(), []);
    const outputPath = await manager.writeOutput('test.md', '# Test');

    expect(outputPath).toContain('outputs');
    const content = await fs.readFile(outputPath, 'utf-8');
    expect(content).toBe('# Test');
  });

  it('creates schema references without draft output files on bundle creation', async () => {
    await createBundle(manager, makeTarget(), []);
    await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'review.md'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'replies.json'))).rejects.toThrow();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'))).rejects.toThrow();
    await expect(
      fs.access(path.join(tmpDir, '.revpack', 'schemas', 'new-findings.schema.json')),
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'schemas', 'replies.schema.json'))).resolves.toBeUndefined();
    // .gitignore should be created to exclude bundle from version control
    const gitignore = await fs.readFile(path.join(tmpDir, '.revpack', '.gitignore'), 'utf-8');
    expect(gitignore).toBe('*\n');
  });

  it('loadBundleState returns null when no bundle exists', async () => {
    const state = await manager.loadBundleState();
    expect(state).toBeNull();
  });

  it('buildThreadIndex derives T-NNN from position', () => {
    const thread1 = { ...makeThread(), threadId: 'aaa' };
    const thread2 = { ...makeThread(), threadId: 'bbb' };
    const thread3 = { ...makeThread(), threadId: 'ccc' };

    const index = WorkspaceManager.buildThreadIndex([thread1, thread2, thread3]);
    expect(index.get('aaa')).toBe('T-001');
    expect(index.get('bbb')).toBe('T-002');
    expect(index.get('ccc')).toBe('T-003');
    expect(index.size).toBe(3);
  });

  it('derives T-NNN IDs from position in all-threads list', async () => {
    const thread1 = makeThread();
    const thread2 = { ...makeThread(), threadId: 'thread-xyz', comments: thread1.comments };

    // Two threads → T-001 and T-002 based on position
    await createBundle(manager, makeTarget(), [thread1, thread2]);

    const threadDir = path.join(tmpDir, '.revpack', 'threads');
    const files = (await fs.readdir(threadDir)).sort();
    expect(files).toContain('T-001.json');
    expect(files).toContain('T-002.json');

    // No thread-map.json file should exist
    const mapPath = path.join(tmpDir, '.revpack', 'thread-map.json');
    expect(await fileExists(mapPath)).toBe(false);

    // Second run with different threads: positions are recalculated
    const thread3 = { ...makeThread(), threadId: 'thread-new', comments: thread1.comments };
    await createBundle(manager, makeTarget(), [thread2, thread3]);

    const files2 = (await fs.readdir(threadDir)).filter((f) => f.endsWith('.json')).sort();
    // thread2 is now at position 0 → T-001, thread3 at position 1 → T-002
    expect(files2).toEqual(['T-001.json', 'T-002.json']);

    const t1 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-001.json'), 'utf-8'));
    expect(t1.threadId).toBe('thread-xyz');
    const t2 = JSON.parse(await fs.readFile(path.join(threadDir, 'T-002.json'), 'utf-8'));
    expect(t2.threadId).toBe('thread-new');
  });

  it('writes resolved review threads to resolved-threads with stable T-NNN IDs', async () => {
    const activeThread = makeThread();
    const resolvedThread = { ...makeThread(), threadId: 'thread-resolved', resolved: true };
    const allThreads = [activeThread, resolvedThread];
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);

    await manager.createBundle(makeTarget(), [activeThread], [], [], threadIndex, {
      resolvedThreads: [resolvedThread],
    });

    await expect(fs.access(path.join(tmpDir, '.revpack', 'threads', 'T-001.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'resolved-threads', 'T-002.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(tmpDir, '.revpack', 'threads', 'T-002.json'))).rejects.toThrow();

    const resolvedJson = JSON.parse(
      await fs.readFile(path.join(tmpDir, '.revpack', 'resolved-threads', 'T-002.json'), 'utf-8'),
    );
    expect(resolvedJson.threadId).toBe('thread-resolved');
    expect(resolvedJson.resolved).toBe(true);
  });

  it('rewrites resolved-threads on each bundle creation', async () => {
    const activeThread = makeThread();
    const resolvedThread = { ...makeThread(), threadId: 'thread-resolved', resolved: true };
    const firstIndex = WorkspaceManager.buildThreadIndex([activeThread, resolvedThread]);

    await manager.createBundle(makeTarget(), [activeThread], [], [], firstIndex, {
      resolvedThreads: [resolvedThread],
    });

    const secondIndex = WorkspaceManager.buildThreadIndex([activeThread]);
    await manager.createBundle(makeTarget(), [activeThread], [], [], secondIndex);

    const resolvedFiles = await fs.readdir(path.join(tmpDir, '.revpack', 'resolved-threads'));
    expect(resolvedFiles).toEqual([]);
  });

  it('resolves T-NNN from thread JSON files on disk', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const resolved = await manager.resolveThreadRef('T-001');
    expect(resolved).toBe('thread-abc');
  });

  it('resolves T-NNN from resolved thread JSON files on disk', async () => {
    const resolvedThread = { ...makeThread(), resolved: true };
    const threadIndex = WorkspaceManager.buildThreadIndex([resolvedThread]);
    await manager.createBundle(makeTarget(), [], [], [], threadIndex, {
      resolvedThreads: [resolvedThread],
    });

    const resolved = await manager.resolveThreadRef('T-001');
    expect(resolved).toBe('thread-abc');
  });

  it('passes through non-T-NNN refs unchanged', async () => {
    const resolved = await manager.resolveThreadRef('abc123def');
    expect(resolved).toBe('abc123def');
  });

  it('does not match T-NNN pattern with prefix or suffix', async () => {
    // Prefix before T- should not match (tests ^ anchor)
    const withPrefix = await manager.resolveThreadRef('XXX-T-001');
    expect(withPrefix).toBe('XXX-T-001');
    // Suffix after digits should not match (tests $ anchor)
    const withSuffix = await manager.resolveThreadRef('T-001-extra');
    expect(withSuffix).toBe('T-001-extra');
  });

  it('prunes stale replies on incremental runs', async () => {
    const threads = [makeThread()];
    const { threadIndex } = await createBundle(manager, makeTarget(), threads);

    // Write a replies.json with two entries
    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([
        { threadId: 'T-001', body: 'reply1', resolve: true },
        { threadId: 'T-999', body: 'stale reply', resolve: false },
      ]),
      'utf-8',
    );

    // Prune with only thread-abc active
    const activeIds = new Set(['thread-abc']);
    const pruned = await manager.pruneStaleReplies(activeIds, threadIndex);
    expect(pruned).toBe(1);

    const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].threadId).toBe('T-001');
  });

  it('preserves replies for resolved threads that are still known', async () => {
    const activeThread = makeThread();
    const resolvedThread = { ...makeThread(), threadId: 'thread-resolved', resolved: true };
    const allThreads = [activeThread, resolvedThread];
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
    await manager.createBundle(makeTarget(), [activeThread], [], [], threadIndex, {
      resolvedThreads: [resolvedThread],
    });

    const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
    await fs.writeFile(
      repliesPath,
      JSON.stringify([
        { threadId: 'T-002', body: 'resolved reply', resolve: false },
        { threadId: 'T-999', body: 'stale reply', resolve: false },
      ]),
      'utf-8',
    );

    const pruned = await manager.pruneStaleReplies(new Set(['thread-abc', 'thread-resolved']), threadIndex);
    expect(pruned).toBe(1);

    const remaining = JSON.parse(await fs.readFile(repliesPath, 'utf-8'));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].threadId).toBe('T-002');
  });

  it('returns 0 when pruning with no replies file', async () => {
    await createBundle(manager, makeTarget(), []);
    const pruned = await manager.pruneStaleReplies(new Set(), new Map());
    expect(pruned).toBe(0);
  });

  it('removeBundle removes entire directory', async () => {
    await createBundle(manager, makeTarget(), [makeThread()]);

    const bundleDir = path.join(tmpDir, '.revpack');
    expect(await fileExists(bundleDir)).toBe(true);

    await manager.removeBundle();
    expect(await fileExists(bundleDir)).toBe(false);
  });

  it('removeBundle is safe when nothing exists', async () => {
    await expect(manager.removeBundle()).resolves.not.toThrow();
  });

  it('emits thread items for active and resolved thread material', () => {
    const activeThread = makeThread();
    const resolvedThread = { ...makeThread(), threadId: 'thread-resolved', resolved: true };
    const allThreads = [activeThread, resolvedThread];
    const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);

    const bundleState = manager.buildBundleState(
      makeTarget(),
      allThreads,
      [],
      threadIndex,
      {
        mode: 'fresh',
        checkpoint: null,
        current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
        comparison: {
          targetCodeChangedSinceCheckpoint: null,
          threadsChangedSinceCheckpoint: null,
          descriptionChangedSinceCheckpoint: null,
        },
      },
      {
        repositoryRoot: tmpDir,
        branch: 'feature/test',
        headSha: 'bbb',
        matchesTargetSourceBranch: true,
        matchesTargetHead: true,
        checkedAt: '2026-01-01T00:00:00Z',
      },
      undefined,
      undefined,
      allThreads,
    );

    expect(bundleState.threads.items.map((item) => item.providerThreadId)).toEqual(['thread-abc', 'thread-resolved']);
    expect(bundleState.threads.items.map((item) => item.file)).toEqual([
      '.revpack/threads/T-001.json',
      '.revpack/resolved-threads/T-002.json',
    ]);
  });

  it('adds paths.commits only when commit list exists', () => {
    const threadIndex = WorkspaceManager.buildThreadIndex([]);
    const prepareSummary: PrepareSummary = {
      mode: 'fresh',
      checkpoint: null,
      current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
      comparison: {
        targetCodeChangedSinceCheckpoint: null,
        threadsChangedSinceCheckpoint: null,
        descriptionChangedSinceCheckpoint: null,
      },
    };
    const localMetadata: BundleLocal = {
      repositoryRoot: tmpDir,
      branch: 'feature/test',
      headSha: 'bbb',
      matchesTargetSourceBranch: true,
      matchesTargetHead: true,
      checkedAt: '2026-01-01T00:00:00Z',
    };

    const withoutCommits = manager.buildBundleState(makeTarget(), [], [], threadIndex, prepareSummary, localMetadata);
    const withCommits = manager.buildBundleState(
      makeTarget(),
      [],
      [],
      threadIndex,
      prepareSummary,
      localMetadata,
      undefined,
      undefined,
      [],
      { hasCommitList: true },
    );

    expect(withoutCommits.paths.commits).toBeUndefined();
    expect(withCommits.paths.commits).toBe('.revpack/commits.md');
  });

  it('writes incremental diff patch', async () => {
    await createBundle(manager, makeTarget(), []);

    const incrementalDiff: ReviewDiff = {
      oldPath: 'src/foo.ts',
      newPath: 'src/foo.ts',
      diff: '+new incremental line',
      newFile: false,
      renamedFile: false,
      deletedFile: false,
    };
    await manager.writeIncrementalDiff([incrementalDiff]);

    const patchPath = path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch');
    const patch = await fs.readFile(patchPath, 'utf-8');
    expect(patch).toContain('diff --git a/src/foo.ts b/src/foo.ts');
    expect(patch).toContain('+new incremental line');
  });

  describe('writeContext', () => {
    it('writes CONTEXT.md with MR metadata', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads, [makeDiff()]);

      const contextPath = await manager.writeContext(makeTarget(), threads, [makeDiff()], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('# Review Context');
      expect(content).toContain('!42');
      expect(content).toContain('Test MR');
      expect(content).toContain('@alice');
      expect(content).toContain('feature/test');
    });

    it('includes thread overview table', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('src/app.ts');
    });

    it('includes changed files list', async () => {
      const newFileDiff: ReviewDiff = {
        ...makeDiff(),
        newFile: true,
        newPath: 'src/new-file.ts',
        oldPath: 'src/new-file.ts',
      };
      const deletedDiff: ReviewDiff = {
        ...makeDiff(),
        deletedFile: true,
        newPath: 'src/old.ts',
        oldPath: 'src/old.ts',
      };
      const renamedDiff: ReviewDiff = {
        ...makeDiff(),
        renamedFile: true,
        oldPath: 'src/before.ts',
        newPath: 'src/after.ts',
      };
      const binaryDiff: ReviewDiff = {
        ...makeDiff(),
        diff: '',
        newFile: true,
        oldPath: 'assets/new-image.png',
        newPath: 'assets/new-image.png',
      };

      const allDiffs = [makeDiff(), newFileDiff, deletedDiff, renamedDiff, binaryDiff];
      const { threadIndex } = await createBundle(manager, makeTarget(), [], allDiffs);

      const contextPath = await manager.writeContext(makeTarget(), [], allDiffs, threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Files');
      expect(content).toContain(
        'This is a derived orientation summary. `.revpack/diffs/files.json` is the authoritative changed-file index.',
      );
      expect(content).toContain('| File | Status | Added | Removed |');
      expect(content).toContain('`src/app.ts`');
      expect(content).toContain('| `src/app.ts` | modified | +1 | −0 |');
      expect(content).toContain('| `src/new-file.ts` | added | +1 | −0 |');
      expect(content).toContain('| `src/old.ts` | deleted | +1 | −0 |');
      expect(content).toContain('| `src/after.ts` | renamed | +1 | −0 |');
      expect(content).toContain('| `assets/new-image.png` | added | — | — |');
    });

    it('includes commit messages as context when commit-list state is present', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), [], [makeDiff()], [], [makeCommit()]);

      const contextPath = await manager.writeContext(makeTarget(), [], [makeDiff()], threadIndex, {
        hasCommitList: true,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Commit Messages');
      expect(content).toContain('The commit list is available at `.revpack/commits.md`.');
      expect(content).toContain('Treat commit messages as intent context only.');
      expect(content).toContain(
        '| `.revpack/commits.md` | Commit messages for the reviewed non-merge commits; intent context only |',
      );
      expect(content).toContain('Read `.revpack/commits.md` for commit-message intent context.');
      expect(content).not.toContain('`.revpack/commits.md` —');
    });

    it('omits commit message context when commits.md is missing or empty', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), [], [makeDiff()]);

      const contextPath = await manager.writeContext(makeTarget(), [], [makeDiff()], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Commit Messages');
      expect(content).not.toContain('`.revpack/commits.md`');
    });

    it('excludes resolved changed threads from the full checkpoint comparison set', async () => {
      const activeThread = makeThread();
      const resolvedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'thread-resolved',
        resolved: true,
        comments: [
          {
            id: 'resolved-note',
            body: 'This was fixed in the latest push',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const allThreads = [activeThread, resolvedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
      await manager.createBundle(makeTarget(), [activeThread], [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), [activeThread], [], threadIndex, {
        changedThreadIds: new Set(['thread-resolved']),
        allThreads,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Changed Threads Since Last Checkpoint');
      expect(content).not.toContain('| T-002 | resolved |');
      expect(content).not.toContain('This was fixed in the latest push');
    });

    it('escapes markdown table separators in thread snippets', async () => {
      const threadWithPipe: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'note-with-pipe',
            body: 'Use foo | bar handling here',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [threadWithPipe]);

      const contextPath = await manager.writeContext(makeTarget(), [threadWithPipe], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Use foo \\| bar handling here');
    });

    it('replaces newlines with spaces in table cells', async () => {
      const target = { ...makeTarget(), title: 'Fix auth\nand validation' };
      const { threadIndex } = await createBundle(manager, target, []);
      const contextPath = await manager.writeContext(target, [], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Newlines in table cell should be collapsed to spaces
      expect(content).toContain('Fix auth and validation');
      expect(content).not.toContain('Fix auth\n');
    });

    it('shows review checkpoint summary with checkpoint and code changes', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Review Checkpoint Summary');
      expect(content).toContain('Last review checkpoint');
      expect(content).toContain('| Target code changed since checkpoint | yes |');
      // Proactive review with code change → shows incremental.patch instruction
      expect(content).toContain('incremental.patch');
      expect(content).toContain('patches/by-file/');
    });

    it('shows threads/description change status in checkpoint summary', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: true,
            descriptionChangedSinceCheckpoint: false,
          },
        },
        hasCommitList: true,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Threads/replies changed since checkpoint | yes');
      expect(content).toContain('Description changed since checkpoint | no');
      // When code didn't change but threads did, show thread-focus message
      expect(content).toContain('threads or replies have been updated');
    });

    it('writes incremental CONTEXT.md with checkpoint delta rules and scoped navigation', async () => {
      const incrementalDiff: ReviewDiff = {
        ...makeStructuredDiff(),
        oldPath: 'src/incremental.ts',
        newPath: 'src/incremental.ts',
      };
      const fullDiffs = [makeDiff(), incrementalDiff];
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads, fullDiffs);
      await manager.writeIncrementalDiff([incrementalDiff]);

      const contextPath = await manager.writeContext(makeTarget(), threads, fullDiffs, threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
        publishedActions: [
          {
            type: 'finding',
            location: { oldPath: 'src/app.ts', newPath: 'src/app.ts', newLine: 2 },
            severity: 'medium',
            category: 'correctness',
            title: 'Earlier finding',
            publishedAt: '2026-01-01T12:00:00Z',
          },
        ],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Incremental Review Rules');
      expect(content).toContain('Incremental mode limits required review effort. It does not limit valid reporting.');
      expect(content).toContain(
        'Do not remove or suppress a valid finding solely because the relevant line is outside `.revpack/diffs/incremental.patch`.',
      );
      expect(content).not.toContain('## Changed Files');
      expect(content).toContain('## Files Changed Since Last Checkpoint');
      expect(content).toContain('This table is a derived orientation summary of the checkpoint delta.');
      expect(content).toContain('| `src/incremental.ts` | modified | +2 | −1 |');
      expect(content).toContain('## Files Changed in Current MR/PR');
      expect(content).toContain('`.revpack/diffs/files.json` is the authoritative changed-file index.');
      expect(content).toContain('`src/app.ts`');
      expect(content).toContain(
        'The per-file Anchor Maps listed in `.revpack/diffs/files.json` contain valid positional anchors for the current MR/PR diff, not only the checkpoint delta.',
      );
      expect(content).toContain(
        'Do not treat the absence of a previous action as proof that no issue exists. If a concrete MR/PR issue was missed by an earlier review pass, it may still be reported now.',
      );

      const incrementalIndex = content.indexOf('Read `.revpack/diffs/incremental.patch`');
      const filesJsonIndex = content.indexOf('Use `.revpack/diffs/files.json`');
      const byFileIndex = content.indexOf('`.revpack/diffs/patches/by-file/`', incrementalIndex);
      expect(incrementalIndex).toBeGreaterThan(-1);
      expect(filesJsonIndex).toBeGreaterThan(incrementalIndex);
      expect(byFileIndex).toBeGreaterThan(incrementalIndex);
    });

    it('places commit messages before incremental diff context in incremental reading order', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads, [makeDiff()], [], [makeCommit()]);
      await manager.writeIncrementalDiff([makeDiff()]);

      const contextPath = await manager.writeContext(makeTarget(), threads, [makeDiff()], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
        hasCommitList: true,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      const commitsIndex = content.indexOf('Read `.revpack/commits.md` for commit-message intent context.');
      const incrementalIndex = content.indexOf('Read `.revpack/diffs/incremental.patch`');
      expect(commitsIndex).toBeGreaterThan(-1);
      expect(incrementalIndex).toBeGreaterThan(commitsIndex);
    });

    it('distinguishes incremental thread updates from unresolved threads requiring attention', async () => {
      const activeThread = makeThread();
      const resolvedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'thread-resolved',
        resolved: true,
        comments: [
          {
            id: 'resolved-note',
            body: 'Resolved in the newest push',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const allThreads = [activeThread, resolvedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
      await manager.createBundle(makeTarget(), [activeThread], [makeDiff()], [], threadIndex);
      await manager.writeIncrementalDiff([makeDiff()]);

      const contextPath = await manager.writeContext(makeTarget(), [activeThread], [makeDiff()], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: true,
            descriptionChangedSinceCheckpoint: false,
          },
        },
        changedThreadIds: new Set(['thread-resolved']),
        allThreads,
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Thread Updates Since Last Checkpoint');
      expect(content).not.toContain('| T-002 | resolved |');
      expect(content).toContain('## Unresolved Threads Requiring Attention');
      expect(content).toContain('These unresolved threads may need replies or resolution.');
    });

    it('includes workflow instructions', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Current Run Mode');
      expect(content).toContain('| Mode | Fresh review |');
      expect(content).toContain('## Review Contract');
      expect(content).toContain('## Suggested Reading Order');
      expect(content).toContain('REVIEW.md');
      expect(content).toContain(
        'Read existing drafts in `.revpack/outputs/`, if present, and follow the rerun rules in the workflow instructions.',
      );
      expect(content).toContain('Use `.revpack/INSTRUCTIONS.md` only as a catalog');
      expect(content).not.toContain('Read `.revpack/AGENT_CONTRACT.md`');
    });

    it('includes Required Instructions section skipping thread-replies when no unresolved threads', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Required Instructions for This Run');
      expect(content).toContain('`.revpack/instructions/01-review-workflow-and-outputs.md`');
      expect(content).toContain('Skipped this run:');
      expect(content).toContain('`.revpack/instructions/02-thread-replies.md` — skip, no unresolved threads');
      // Fresh review (no prepareSummary) → proactive review instructions required
      expect(content).not.toContain('03-new-findings-and-anchors.md` — skip');

      const workflowInstructions = await fs.readFile(
        path.join(tmpDir, '.revpack', 'instructions', '01-review-workflow-and-outputs.md'),
        'utf-8',
      );
      expect(workflowInstructions).toContain('## Rerunning a review');
      expect(workflowInstructions).toContain(
        'Existing `replies.json`, `new-findings.json`, and `review.md` are pending, revisable drafts.',
      );
      expect(content).toContain('`.revpack/instructions/03-new-findings-and-anchors.md`');
    });

    it('includes thread-replies instruction when unresolved threads exist', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Required Instructions for This Run');
      expect(content).not.toContain('skip, no unresolved threads');
      // 02 is required, not skipped
      expect(content).not.toContain('02-thread-replies.md` — skip');
      expect(content).toContain('`.revpack/instructions/02-thread-replies.md`');
    });

    it('routes thread-only refreshes away from proactive review instructions', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'xxx',
            startSha: 'xxx',
            threadsDigest: 'old',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'aaa', localHeadSha: 'aaa', threadsDigest: 'new' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: true,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('| Mode | Thread follow-up |');
      expect(content).toContain('`.revpack/instructions/02-thread-replies.md`');
      expect(content).not.toMatch(/^\d+\. `\.revpack\/instructions\/03-new-findings-and-anchors\.md`/m);
      expect(content).toContain(
        '`.revpack/instructions/03-new-findings-and-anchors.md` — skip, no new target code to review proactively',
      );
      // Non-proactive review → no per-file review step in reading order
      expect(content).not.toContain('Use `.revpack/diffs/patches/by-file/` for focused review');
      // Non-proactive → no latest.patch reading order step either
      expect(content).not.toContain('for the overall change and cross-file context');
      // Non-proactive → no line-map/change-blocks steps
      expect(content).not.toContain('choose valid review anchors before creating findings');
      // Checkpoint-specific guidance for thread-only refresh
      expect(content).toContain('threads or replies have been updated');
      expect(content).toContain('Focus on updated unresolved threads');
      // All proactive instructions are skipped with specific reasons
      expect(content).toContain('skip, no new findings pass is expected');
      expect(content).toContain('skip, no MR/PR-level synthesis pass is expected');
      expect(content).toContain('skip, no code-change summary update is expected');
    });

    it('shows general comments section for non-resolvable human threads', async () => {
      const resolvableThread = makeThread();
      const generalComment: ReviewThread = {
        ...makeThread(),
        threadId: 'general-1',
        resolvable: false,
        comments: [
          {
            id: 'gen-1',
            body: 'Great work on this MR overall!',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };

      const allThreads = [resolvableThread, generalComment];
      const threadIndex = WorkspaceManager.buildThreadIndex(allThreads);
      await manager.createBundle(makeTarget(), allThreads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), allThreads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
      expect(content).toContain('## General Comments');
      expect(content).toContain('T-002');
      expect(content).toContain('@reviewer');
      expect(content).toContain('Great work on this MR overall!');
    });

    it('shows Previous Actions section when publishedActions are provided', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        publishedActions: [
          {
            type: 'reply',
            providerThreadId: 'thread-abc',
            title: 'Fixed, good catch!',
            publishedAt: '2026-01-01T12:00:00Z',
          },
          {
            type: 'finding',
            location: { oldPath: 'src/auth.ts', newPath: 'src/auth.ts', newLine: 42 },
            severity: 'high',
            category: 'correctness',
            title: 'Unsafe token',
            publishedAt: '2026-01-01T12:01:00Z',
          },
        ],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Previous Actions');
      expect(content).toContain('Reply');
      expect(content).toContain('Finding');
      expect(content).toContain('src/auth.ts');
    });

    it('shows resolve type and oldLine fallback in Previous Actions', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        publishedActions: [
          {
            type: 'resolve',
            providerThreadId: 'resolved-thread-1',
            title: 'Resolved issue',
            publishedAt: '2026-01-01T12:00:00Z',
          },
          {
            type: 'finding',
            location: { oldPath: 'src/legacy.ts', newPath: 'src/legacy.ts', oldLine: 99 },
            severity: 'medium',
            category: 'style',
            title: 'Deprecated pattern',
            publishedAt: '2026-01-01T12:01:00Z',
          },
        ],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      // Action column should show 'Resolve' as the type label (distinct from title "Resolved issue")
      expect(content).toMatch(/\| Resolve \|.*resolved-thread-1/);
      expect(content).toContain('resolved-thread-1');
      // oldLine fallback (no newLine) should show :99
      expect(content).toContain(':99');
      expect(content).toContain('Deprecated pattern');
    });

    it('uses oldPath fallback and ? for missing line numbers in actions', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        publishedActions: [
          {
            type: 'finding',
            location: { oldPath: 'src/deleted.ts', newPath: '', oldLine: undefined, newLine: undefined },
            severity: 'low',
            category: 'documentation',
            title: 'Missing docs',
            publishedAt: '2026-01-02T00:00:00Z',
          },
        ],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      // newPath is empty so falls back to oldPath
      expect(content).toContain('src/deleted.ts');
      // Both line numbers missing → shows '?'
      expect(content).toContain(':?');
    });

    it('tags SELF on threads created by published findings', async () => {
      const selfThread: ReviewThread = {
        ...makeThread(),
        threadId: 'self-thread-sha',
        position: { filePath: 'src/auth.ts', newLine: 42 },
        comments: [
          {
            id: 'self-note',
            body: '<!-- revpack -->\nUnsafe token comparison',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [makeThread(), selfThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('SELF');
      // T-001 should NOT be tagged SELF
      expect(content).not.toMatch(/T-001.*SELF/);
    });

    it('tags SELF on Bitbucket-compatible revpack footer comments', async () => {
      const selfThread: ReviewThread = {
        ...makeThread(),
        provider: 'bitbucket-cloud',
        targetRef: {
          provider: 'bitbucket-cloud',
          repository: 'group/project',
          targetType: 'pull_request',
          targetId: '42',
        },
        threadId: 'bitbucket-self-thread',
        comments: [
          {
            id: 'self-note',
            body: 'Unsafe token comparison\n\n###### 🤖 Generated by [revpack](https://github.com/stefanvictora/revpack)',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [makeThread(), selfThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('SELF');
      expect(content).not.toMatch(/T-001.*SELF/);
    });

    it('derives SELF and REPLIED from chronological comments, not provider order', async () => {
      const selfThread: ReviewThread = {
        ...makeThread(),
        threadId: 'self-thread',
        comments: [
          {
            id: 'later-human',
            body: 'Follow-up question',
            author: 'reviewer',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'first-bot',
            body: '<!-- revpack -->\nOriginal finding',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const repliedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'replied-thread',
        comments: [
          {
            id: 'later-bot',
            body: '<!-- revpack -->\nFixed now',
            author: 'bot',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'bot',
            system: false,
          },
          {
            id: 'first-human',
            body: 'Please fix',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const threads = [selfThread, repliedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toMatch(/T-001 \| SELF/);
      expect(content).toMatch(/T-002 \| REPLIED/);
    });

    it('does not tag bot-authored threads as SELF without the revpack marker', async () => {
      const codeRabbitThread: ReviewThread = {
        ...makeThread(),
        provider: 'github',
        targetRef: {
          provider: 'github',
          repository: 'group/project',
          targetType: 'pull_request',
          targetId: '42',
        },
        threadId: 'coderabbit-thread',
        comments: [
          {
            id: 'coderabbit-note',
            body: 'This check can report a false positive here.',
            author: 'coderabbitai',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [codeRabbitThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      const row = content.match(/\| T-001 \|.*\| @coderabbitai \|/)?.[0] ?? '';
      expect(row).toMatch(/\| T-001 \| {2}\| @coderabbitai \|/);
      expect(row).not.toContain('SELF');
      expect(row).not.toContain('REPLIED');
    });

    it('tags REPLIED on threads that have a bot reply', async () => {
      const repliedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'replied-thread-sha',
        comments: [
          {
            id: 'human-note',
            body: 'This needs fixing',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'bot-reply',
            body: '<!-- revpack -->\nFixed, good catch!',
            author: 'bot',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const threads = [repliedThread];
      const threadIndex = WorkspaceManager.buildThreadIndex(threads);
      await manager.createBundle(makeTarget(), threads, [], [], threadIndex);

      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('REPLIED');
    });

    it('omits Previous Actions section when no actions exist', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        publishedActions: [],
      });

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Previous Actions');
    });

    it('references description.md for MR description', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);

      const contextPath = await manager.writeContext(makeTarget(), [], [makeDiff()], threadIndex);

      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('description.md');
    });

    it('shows threads directory entry only when threads exist', async () => {
      // No threads → no threads count entry in file map
      const { threadIndex: ti0 } = await createBundle(manager, makeTarget(), []);
      const ctx0 = await manager.writeContext(makeTarget(), [], [makeDiff()], ti0);
      const content0 = await fs.readFile(ctx0, 'utf-8');
      expect(content0).not.toContain('thread(s)');

      // With a resolvable thread + a general comment → shows total count
      const thread: ReviewThread = { ...makeThread(), resolvable: true, resolved: false };
      const general: ReviewThread = { ...makeThread(), threadId: 'gen-1', resolvable: false };
      const threads = [thread, general];
      const { threadIndex: ti1 } = await createBundle(manager, makeTarget(), threads);
      const ctx1 = await manager.writeContext(makeTarget(), threads, [], ti1);
      const content1 = await fs.readFile(ctx1, 'utf-8');
      expect(content1).toContain('2 thread(s)');
    });

    it('excludes resolved threads from Unresolved Threads section', async () => {
      const resolved: ReviewThread = { ...makeThread(), threadId: 'res-1', resolved: true, resolvable: true };
      const unresolved: ReviewThread = { ...makeThread(), threadId: 'unres-1', resolved: false, resolvable: true };
      const threads = [resolved, unresolved];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const ctx = await manager.writeContext(makeTarget(), threads, [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      const unresolvedSection = content.split('## Unresolved Threads')[1]?.split('##')[0] ?? '';
      expect(unresolvedSection).toContain('T-002');
      expect(unresolvedSection).not.toContain('T-001');
    });

    it('excludes non-resolvable threads from Unresolved Threads section', async () => {
      const nonResolvable: ReviewThread = { ...makeThread(), threadId: 'nr-1', resolved: false, resolvable: false };
      const resolvable: ReviewThread = { ...makeThread(), threadId: 'r-1', resolved: false, resolvable: true };
      const threads = [nonResolvable, resolvable];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const ctx = await manager.writeContext(makeTarget(), threads, [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      const unresolvedSection = content.split('## Unresolved Threads')[1]?.split('##')[0] ?? '';
      expect(unresolvedSection).toContain('T-002');
      expect(unresolvedSection).not.toContain('T-001');
    });

    it('does not flag SELF or REPLIED on threads with only human comments', async () => {
      const humanOnly: ReviewThread = {
        ...makeThread(),
        threadId: 'human-only',
        resolvable: true,
        resolved: false,
        comments: [
          {
            id: 'h1',
            body: 'Please fix',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'h2',
            body: 'Agreed',
            author: 'other',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [humanOnly]);
      const ctx = await manager.writeContext(makeTarget(), [humanOnly], [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      const row = content.match(/\| T-001 \|.*\| @reviewer \|/)?.[0] ?? '';
      expect(row).not.toContain('SELF');
      expect(row).not.toContain('REPLIED');
    });

    it('omits Unresolved Threads section when all threads are resolved', async () => {
      const resolved: ReviewThread = { ...makeThread(), resolved: true, resolvable: true };
      const { threadIndex } = await createBundle(manager, makeTarget(), [resolved]);
      const ctx = await manager.writeContext(makeTarget(), [resolved], [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      expect(content).not.toContain('## Unresolved Threads');
    });

    it('omits General Comments section when no non-resolvable threads', async () => {
      const resolvable: ReviewThread = { ...makeThread(), resolvable: true, resolved: false };
      const { threadIndex } = await createBundle(manager, makeTarget(), [resolvable]);
      const ctx = await manager.writeContext(makeTarget(), [resolvable], [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      expect(content).not.toContain('## General Comments');
    });

    it('handles system-only unresolved thread without crashing', async () => {
      const systemOnly: ReviewThread = {
        ...makeThread(),
        threadId: 'sys-only',
        resolvable: true,
        resolved: false,
        comments: [
          {
            id: 's1',
            body: 'auto-resolved',
            author: 'gitlab',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: true,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [systemOnly]);
      const ctx = await manager.writeContext(makeTarget(), [systemOnly], [], threadIndex);
      const content = await fs.readFile(ctx, 'utf-8');
      // Should render without crashing, with fallback values
      expect(content).toContain('## Unresolved Threads');
      expect(content).toContain('T-001');
    });
  });

  describe('appendPublishedAction', () => {
    it('appends action to existing bundle.json', async () => {
      await createBundle(manager, makeTarget(), []);

      // First save a bundle state
      const bundleState = manager.buildBundleState(
        makeTarget(),
        [],
        [],
        new Map(),
        {
          mode: 'fresh',
          checkpoint: null,
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
        {
          repositoryRoot: tmpDir,
          branch: 'feature/test',
          headSha: 'bbb',
          matchesTargetSourceBranch: true,
          matchesTargetHead: true,
          checkedAt: '2026-01-01T00:00:00Z',
        },
      );
      await manager.saveBundleState(bundleState);

      const appended = await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-abc',
        title: 'Fixed!',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      expect(appended).toBe(true);

      const state = await manager.loadBundleState();
      expect(state!.publishedActions).toHaveLength(1);
      expect(state!.publishedActions[0].providerThreadId).toBe('thread-abc');
    });

    it('accumulates multiple actions', async () => {
      await createBundle(manager, makeTarget(), []);

      const bundleState = manager.buildBundleState(
        makeTarget(),
        [],
        [],
        new Map(),
        {
          mode: 'fresh',
          checkpoint: null,
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
        {
          repositoryRoot: tmpDir,
          branch: 'feature/test',
          headSha: 'bbb',
          matchesTargetSourceBranch: true,
          matchesTargetHead: true,
          checkedAt: '2026-01-01T00:00:00Z',
        },
      );
      await manager.saveBundleState(bundleState);

      await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-abc',
        title: 'First',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      await manager.appendPublishedAction({
        type: 'finding',
        location: { oldPath: 'src/app.ts', newPath: 'src/app.ts', newLine: 10 },
        severity: 'high',
        category: 'correctness',
        title: 'Second',
        publishedAt: '2026-01-01T12:01:00Z',
      });

      const state = await manager.loadBundleState();
      expect(state!.publishedActions).toHaveLength(2);
    });

    it('returns false when no bundle exists', async () => {
      const result = await manager.appendPublishedAction({
        type: 'reply',
        providerThreadId: 'thread-1',
        title: 'No bundle',
        publishedAt: '2026-01-01T12:00:00Z',
      });
      expect(result).toBe(false);
    });
  });

  describe('files.json status and binary metadata', () => {
    it('marks a text addition as added with oldExists=false, newExists=true', async () => {
      const addedDiff: ReviewDiff = {
        oldPath: 'src/New.ts',
        newPath: 'src/New.ts',
        diff: '--- /dev/null\n+++ b/src/New.ts\n@@ -0,0 +1,2 @@\n+const x = 1;\n+export default x;\n',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [addedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('added');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(false);
      expect(entry.newExists).toBe(true);
    });

    it('marks a text deletion as deleted with oldExists=true, newExists=false', async () => {
      const deletedDiff: ReviewDiff = {
        oldPath: 'src/Gone.ts',
        newPath: 'src/Gone.ts',
        diff: '--- a/src/Gone.ts\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-const x = 1;\n-export default x;\n',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      await createBundle(manager, makeTarget(), [], [deletedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('deleted');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(false);
    });

    it('marks a binary addition as added with binary=true', async () => {
      // GitLab returns an empty diff for binary files
      const binaryAddedDiff: ReviewDiff = {
        oldPath: 'assets/logo.png',
        newPath: 'assets/logo.png',
        diff: '',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [binaryAddedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('added');
      expect(entry.binary).toBe(true);
      expect(entry.oldExists).toBe(false);
      expect(entry.newExists).toBe(true);
      expect(entry.added).toBe(0);
      expect(entry.removed).toBe(0);
      expect(entry.anchorMapFile).toBe('anchor-maps/F001-logo.ndjson');
      const anchorMap = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', entry.anchorMapFile), 'utf-8');
      expect(anchorMap).toBe('');
    });

    it('marks a binary deletion as deleted with binary=true', async () => {
      const binaryDeletedDiff: ReviewDiff = {
        oldPath: 'assets/old.png',
        newPath: 'assets/old.png',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      await createBundle(manager, makeTarget(), [], [binaryDeletedDiff]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('deleted');
      expect(entry.binary).toBe(true);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(false);
    });

    it('marks a regular modification as modified with binary=false, both exist', async () => {
      await createBundle(manager, makeTarget(), [], [makeDiff()]);

      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      const entry = filesJson.files[0];
      expect(entry.status).toBe('modified');
      expect(entry.binary).toBe(false);
      expect(entry.oldExists).toBe(true);
      expect(entry.newExists).toBe(true);
    });
  });

  describe('thread JSON targetRef', () => {
    it('writes only the 4 minimal targetRef fields, not the full ReviewTarget', async () => {
      // Simulate what happens when the provider passes a full ReviewTarget as targetRef
      // (ReviewTarget extends ReviewTargetRef, so extra fields bleed through at runtime)
      const threadWithFullTargetRef: ReviewThread = {
        ...makeThread(),
        // Cast to satisfy the type but include extra fields that would come from a ReviewTarget
        targetRef: {
          provider: 'gitlab',
          repository: 'group/project',
          targetType: 'merge_request',
          targetId: '42',
          // Extra fields that must NOT appear in the written JSON
          ...({ title: 'Should not be here', author: 'alice', state: 'opened' } as object),
        },
      };

      await createBundle(manager, makeTarget(), [threadWithFullTargetRef]);

      const threadJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.json'), 'utf-8'));

      expect(Object.keys(threadJson.targetRef)).toEqual(['provider', 'repository', 'targetType', 'targetId']);
      expect(threadJson.targetRef.provider).toBe('gitlab');
      expect(threadJson.targetRef.repository).toBe('group/project');
      expect(threadJson.targetRef.targetType).toBe('merge_request');
      expect(threadJson.targetRef.targetId).toBe('42');
      // Must NOT have extra fields
      expect((threadJson.targetRef as Record<string, unknown>).title).toBeUndefined();
      expect((threadJson.targetRef as Record<string, unknown>).author).toBeUndefined();
    });
  });

  describe('resolveThreadRef with threadIndex', () => {
    it('resolves T-NNN via threadIndex without reading disk', async () => {
      await createBundle(manager, makeTarget(), [makeThread()]);
      const threadIndex: Map<string, string> = new Map([['sha-123', 'T-001']]);
      const resolved = await manager.resolveThreadRef('T-001', threadIndex);
      expect(resolved).toBe('sha-123');
    });

    it('is case-insensitive for T-NNN matching', async () => {
      await createBundle(manager, makeTarget(), [makeThread()]);
      const threadIndex: Map<string, string> = new Map([['sha-abc', 'T-002']]);
      const resolved = await manager.resolveThreadRef('t-002', threadIndex);
      expect(resolved).toBe('sha-abc');
    });

    it('falls back to disk when threadIndex does not contain the ref', async () => {
      await createBundle(manager, makeTarget(), [makeThread()]);
      const threadIndex: Map<string, string> = new Map([['sha-other', 'T-999']]);
      // T-001.json exists on disk from createBundle
      const resolved = await manager.resolveThreadRef('T-001', threadIndex);
      expect(resolved).toBe('thread-abc');
    });

    it('throws when ref not in index and not on disk', async () => {
      await createBundle(manager, makeTarget(), []);
      const threadIndex: Map<string, string> = new Map();
      await expect(manager.resolveThreadRef('T-999', threadIndex)).rejects.toThrow(
        'Cannot resolve thread reference "T-999"',
      );
    });

    it('throws when thread JSON file has no threadId field', async () => {
      await createBundle(manager, makeTarget(), []);
      // Write a malformed thread JSON
      const jsonPath = path.join(tmpDir, '.revpack', 'threads', 'T-050.json');
      await fs.writeFile(jsonPath, JSON.stringify({ noThreadId: true }), 'utf-8');
      await expect(manager.resolveThreadRef('T-050')).rejects.toThrow('Cannot resolve thread reference "T-050"');
    });

    it('throws when thread JSON file has a non-string threadId field', async () => {
      await createBundle(manager, makeTarget(), []);
      const jsonPath = path.join(tmpDir, '.revpack', 'threads', 'T-051.json');
      await fs.writeFile(jsonPath, JSON.stringify({ threadId: 123 }), 'utf-8');
      await expect(manager.resolveThreadRef('T-051')).rejects.toThrow('Cannot resolve thread reference "T-051"');
    });
  });

  describe('getOutputState', () => {
    it('returns empty when no bundle state exists', async () => {
      const state = await manager.getOutputState('summary');
      expect(state).toBe('empty');
    });

    it('returns empty when output file does not exist', async () => {
      await createBundleWithState(manager);
      const state = await manager.getOutputState('summary');
      expect(state).toBe('empty');
    });

    it('returns empty when output file is whitespace only', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '   \n  ');
      const state = await manager.getOutputState('summary');
      expect(state).toBe('empty');
    });

    it('returns pending when content exists but not yet published', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '# Summary\nSome content');
      const state = await manager.getOutputState('summary');
      expect(state).toBe('pending');
    });

    it('returns published when content matches last published hash', async () => {
      await createBundleWithState(manager);
      const content = '# Summary\nSome content';
      await manager.writeOutput('summary.md', content);
      await manager.updateOutputPublishState('summary', computeContentHash(content), 'sha-head');
      const state = await manager.getOutputState('summary');
      expect(state).toBe('published');
    });

    it('returns modified since publish when content differs from published hash', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '# Original');
      await manager.updateOutputPublishState('summary', computeContentHash('# Original'), 'sha-head');
      await manager.writeOutput('summary.md', '# Updated content');
      const state = await manager.getOutputState('summary');
      expect(state).toBe('modified since publish');
    });
  });

  describe('getPendingOutputState', () => {
    it('returns empty when no bundle state exists', async () => {
      const state = await manager.getPendingOutputState('review');
      expect(state).toBe('empty');
    });

    it('returns empty when output file does not exist', async () => {
      await createBundleWithState(manager);
      const state = await manager.getPendingOutputState('review');
      expect(state).toBe('empty');
    });

    it('returns empty when output file is whitespace only', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('review.md', '   \n  ');
      const state = await manager.getPendingOutputState('review');
      expect(state).toBe('empty');
    });

    it('returns pending when review note content exists regardless of legacy publish hash', async () => {
      await createBundleWithState(manager);
      const state = await manager.loadBundleState();
      (state!.outputs.review as { lastPublishedHash?: string }).lastPublishedHash =
        computeContentHash('## Notes\nReview notes');
      await manager.saveBundleState(state!);

      await manager.writeOutput('review.md', '## Notes\nReview notes');

      await expect(manager.getPendingOutputState('review')).resolves.toBe('pending');
    });
  });

  describe('updateOutputPublishState', () => {
    it('returns false when no bundle state exists', async () => {
      const result = await manager.updateOutputPublishState('summary', 'hash', 'sha');
      expect(result).toBe(false);
    });

    it('stores hash, timestamp, and targetHeadSha', async () => {
      await createBundleWithState(manager);
      const result = await manager.updateOutputPublishState('summary', 'abc123', 'head-sha');
      expect(result).toBe(true);

      const state = await manager.loadBundleState();
      expect(state!.outputs.summary.lastPublishedHash).toBe('abc123');
      expect(state!.outputs.summary.lastPublishedTargetHeadSha).toBe('head-sha');
      expect(state!.outputs.summary.lastPublishedAt).toBeTruthy();
    });
  });

  describe('prefillOutputIfEmpty', () => {
    it('writes content when output file does not exist', async () => {
      await createBundle(manager, makeTarget(), []);
      // Remove the default file
      const summaryPath = path.join(tmpDir, '.revpack', 'outputs', 'summary.md');
      await fs.rm(summaryPath, { force: true });

      await manager.prefillOutputIfEmpty('summary.md', '# Prefilled');
      const content = await fs.readFile(summaryPath, 'utf-8');
      expect(content).toBe('# Prefilled');
    });

    it('writes content when output file is empty', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '');
      await manager.prefillOutputIfEmpty('summary.md', '# Prefilled');
      const content = await manager.readOutput('summary.md');
      expect(content).toBe('# Prefilled');
    });

    it('does not overwrite existing non-empty content', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '# Existing');
      await manager.prefillOutputIfEmpty('summary.md', '# New');
      const content = await manager.readOutput('summary.md');
      expect(content).toBe('# Existing');
    });

    it('overwrites whitespace-only content', async () => {
      await createBundleWithState(manager);
      await manager.writeOutput('summary.md', '  \n  ');
      await manager.prefillOutputIfEmpty('summary.md', '# Prefilled');
      const content = await manager.readOutput('summary.md');
      expect(content).toBe('# Prefilled');
    });

    it('updates publish hash so status does not show pending', async () => {
      await createBundleWithState(manager);
      await manager.prefillOutputIfEmpty('summary.md', '# Prefilled');
      const state = await manager.getOutputState('summary');
      expect(state).toBe('published');
    });

    it('works for files without a tracked output state key', async () => {
      await createBundleWithState(manager);
      const filePath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      await fs.writeFile(filePath, '', 'utf-8');
      await manager.prefillOutputIfEmpty('replies.json', '[]');
      const content = await fs.readFile(filePath, 'utf-8');
      expect(content).toBe('[]');
    });
  });

  describe('discardOutputs', () => {
    it('removes text draft output files', async () => {
      await createBundle(manager, makeTarget(), []);
      await manager.writeOutput('summary.md', '# Written content');
      await manager.writeOutput('review.md', '# Review content');
      await manager.discardOutputs();
      await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'summary.md'))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'review.md'))).rejects.toThrow();
    });

    it('removes queue draft output files', async () => {
      await createBundle(manager, makeTarget(), []);
      await manager.writeOutput('replies.json', '[{"threadId":"T-001","body":"hi","resolve":true}]');
      await manager.writeOutput('new-findings.json', '[]');
      await manager.discardOutputs();
      await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'replies.json'))).rejects.toThrow();
      await expect(fs.access(path.join(tmpDir, '.revpack', 'outputs', 'new-findings.json'))).rejects.toThrow();
    });
  });

  describe('pruneStaleReplies edge cases', () => {
    it('returns 0 for invalid JSON in replies file', async () => {
      await createBundle(manager, makeTarget(), []);
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      await fs.writeFile(repliesPath, 'not json', 'utf-8');
      const pruned = await manager.pruneStaleReplies(new Set(), new Map());
      expect(pruned).toBe(0);
    });

    it('returns 0 when replies content is not an array', async () => {
      await createBundle(manager, makeTarget(), []);
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      await fs.writeFile(repliesPath, '{"notAnArray": true}', 'utf-8');
      const pruned = await manager.pruneStaleReplies(new Set(), new Map());
      expect(pruned).toBe(0);
    });

    it('normalizes threadId case and trims whitespace before matching', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      await fs.writeFile(
        repliesPath,
        JSON.stringify([{ threadId: ' t-001 ', body: 'reply', resolve: false }]),
        'utf-8',
      );
      const activeIds = new Set(['thread-abc']);
      const pruned = await manager.pruneStaleReplies(activeIds, threadIndex);
      expect(pruned).toBe(0); // should be kept after normalization
    });

    it('does not rewrite file when nothing was pruned', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const repliesPath = path.join(tmpDir, '.revpack', 'outputs', 'replies.json');
      const original = JSON.stringify([{ threadId: 'T-001', body: 'reply', resolve: true }]);
      await fs.writeFile(repliesPath, original, 'utf-8');
      const activeIds = new Set(['thread-abc']);
      await manager.pruneStaleReplies(activeIds, threadIndex);
      // File should be unchanged (not reformatted)
      const content = await fs.readFile(repliesPath, 'utf-8');
      expect(content).toBe(original);
    });
  });

  describe('writeNoCodeChangeIncrementalPatch', () => {
    it('writes a placeholder message', async () => {
      await createBundle(manager, makeTarget(), []);
      await manager.writeNoCodeChangeIncrementalPatch();
      const content = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
      expect(content).toContain('No code changes since last review checkpoint');
    });
  });

  describe('writeUnavailableIncrementalPatch', () => {
    it('writes the reason as a comment', async () => {
      await createBundle(manager, makeTarget(), []);
      await manager.writeUnavailableIncrementalPatch('History was force-pushed');
      const content = await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'incremental.patch'), 'utf-8');
      expect(content).toBe('# History was force-pushed\n');
    });
  });

  describe('buildBundleState details', () => {
    it('includes tool metadata', () => {
      const state = manager.buildBundleState(makeTarget(), [], [], new Map(), makePrepareSummary(), makeLocal());
      expect(state.tool).toMatchObject({ name: 'revpack' });
    });

    it('omits absolute repository root from persisted local metadata', () => {
      const state = manager.buildBundleState(makeTarget(), [], [], new Map(), makePrepareSummary(), {
        ...makeLocal(),
        repositoryRoot: 'C:\\Users\\alice\\work\\private-repo',
      });

      expect(state.local).not.toHaveProperty('repositoryRoot');
      expect(JSON.stringify(state)).not.toContain('private-repo');
    });

    it('uses first version as providerVersionId', () => {
      const versions: ReviewVersion[] = [
        makeVersion('v-latest', '2026-01-02T00:00:00Z'),
        makeVersion('v-older', '2026-01-01T00:00:00Z'),
      ];
      const state = manager.buildBundleState(makeTarget(), [], versions, new Map(), makePrepareSummary(), makeLocal());
      expect(state.target.providerVersionId).toBe('v-latest');
    });

    it('sets providerVersionId to undefined when no versions', () => {
      const state = manager.buildBundleState(makeTarget(), [], [], new Map(), makePrepareSummary(), makeLocal());
      expect(state.target.providerVersionId).toBeUndefined();
    });

    it('sets incrementalPatch to null when no code change', () => {
      const ps = makePrepareSummary();
      ps.comparison.targetCodeChangedSinceCheckpoint = false;
      const state = manager.buildBundleState(makeTarget(), [], [], new Map(), ps, makeLocal());
      expect(state.paths.incrementalPatch).toBeNull();
    });

    it('sets incrementalPatch path when code changed', () => {
      const ps = makePrepareSummary();
      ps.comparison.targetCodeChangedSinceCheckpoint = true;
      const state = manager.buildBundleState(makeTarget(), [], [], new Map(), ps, makeLocal());
      expect(state.paths.incrementalPatch).toBe('.revpack/diffs/incremental.patch');
    });

    it('uses previousActions and previousOutputs when provided', () => {
      const actions = [
        { type: 'reply' as const, providerThreadId: 'x', title: 'T', publishedAt: '2026-01-01T00:00:00Z' },
      ];
      const outputs = {
        summary: { path: 'custom/summary.md', lastPublishedHash: 'abc' },
        review: { path: 'custom/review.md' },
      };
      const state = manager.buildBundleState(
        makeTarget(),
        [],
        [],
        new Map(),
        makePrepareSummary(),
        makeLocal(),
        actions,
        outputs,
      );
      expect(state.publishedActions).toBe(actions);
      expect(state.outputs.summary.lastPublishedHash).toBe('abc');
    });

    it('populates thread items with latestCommentAt from most recent non-system comment', () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: 'early',
            author: 'a',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
          {
            id: 'c2',
            body: 'later',
            author: 'b',
            createdAt: '2026-01-02T00:00:00Z',
            updatedAt: '2026-01-02T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const threadIndex = WorkspaceManager.buildThreadIndex([thread]);
      const state = manager.buildBundleState(
        makeTarget(),
        [thread],
        [],
        threadIndex,
        makePrepareSummary(),
        makeLocal(),
      );
      expect(state.threads.items[0].latestCommentAt).toBe('2026-01-02T00:00:00Z');
    });

    it('filters system-only threads from items', () => {
      const systemThread: ReviewThread = {
        ...makeThread(),
        threadId: 'sys-thread',
        comments: [
          {
            id: 's1',
            body: 'system',
            author: 'gitlab',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: true,
          },
        ],
      };
      const threadIndex = WorkspaceManager.buildThreadIndex([makeThread(), systemThread]);
      const state = manager.buildBundleState(
        makeTarget(),
        [makeThread(), systemThread],
        [],
        threadIndex,
        makePrepareSummary(),
        makeLocal(),
      );
      expect(state.threads.items).toHaveLength(1);
      expect(state.threads.items[0].providerThreadId).toBe('thread-abc');
    });
  });

  describe('threadToMarkdown via createBundle', () => {
    it('embeds diff context when thread position matches a diff line', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: [
          '@@ -8,5 +8,6 @@ function main()',
          ' const a = 1;',
          ' const b = 2;',
          '-const c = a + b;',
          '+const c = compute(a, b);',
          ' return c;',
          '+log(c);',
        ].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 10 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      // Thread markdown starts with the expected header
      expect(md).toMatch(/^# T-001: Thread thread-abc/);
      expect(md).toContain('## Diff Context');
      expect(md).toContain('```diff');
      expect(md).toContain('compute(a, b)');
      expect(md).toContain('◀');
      // Verify diff context format: prefix characters match line types
      expect(md).toContain('+ '); // added line prefix
      expect(md).toContain('- '); // removed line prefix
      // The targeted line (newLine 10) maps to 'const c = compute(a, b)' which is added
      // Verify the marker ◀ appears on the correct line
      const diffBlock = md.split('```diff')[1].split('```')[0];
      const markedLine = diffBlock.split('\n').find((l) => l.includes('◀'));
      expect(markedLine).toContain('compute(a, b)');
      // Only one line should have the ◀ marker
      expect(diffBlock.split('◀').length).toBe(2); // one occurrence = 2 parts
      // First line of diff context starts with a valid prefix (space, +, or -)
      const firstContextLine = diffBlock.split('\n').find((l) => l.trim().length > 0);
      expect(firstContextLine).toMatch(/^[ +-]/);
      // Context window extends beyond the marked line (verifies +1 after marker)
      expect(diffBlock).toContain('return c');
    });

    it('shows correct context window with 3 lines above and 1 below', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: [
          '@@ -5,9 +5,9 @@ header',
          ' line5',
          ' line6',
          ' line7',
          ' line8',
          ' line9',
          '-oldLine10',
          '+newLine10',
          ' line11',
          ' line12',
        ].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 10 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      const diffBlock = md.split('```diff')[1].split('```')[0];
      const diffLines = diffBlock.trim().split('\n');
      // Context window should show indices 3-7 (line8, line9, -oldLine10, +newLine10, line11)
      // Verify removed and added prefixes appear
      expect(diffLines.some((l) => l.startsWith('-') && l.includes('oldLine10'))).toBe(true);
      expect(diffLines.some((l) => l.startsWith('+') && l.includes('newLine10'))).toBe(true);
      // Verify context line (space prefix) is included
      expect(diffLines.some((l) => l.trimStart().includes('| line8'))).toBe(true);
      // The ◀ marker should be on the newLine10 line (the target)
      expect(diffLines.find((l) => l.includes('◀'))).toContain('newLine10');
      // Lines before the window (line5, line6, line7) should NOT appear
      expect(diffBlock).not.toContain('line5');
      expect(diffBlock).not.toContain('line6');
    });

    it('uses oldLine for position matching when newLine is absent', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: ['@@ -8,4 +8,3 @@ function run()', ' line8', ' line9', '-removedLine10', ' line11'].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', oldLine: 10 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('## Diff Context');
      expect(md).toContain('removedLine10');
      const diffBlock = md.split('```diff')[1].split('```')[0];
      expect(diffBlock).toContain('◀');
    });

    it('shows stale revision warning when headSha does not match', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 10, headSha: 'old-sha' },
      };
      const target = makeTarget(); // diffRefs.headSha = 'bbb'
      await createBundle(manager, target, [thread], [makeDiff()]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('older revision');
      expect(md).toContain('old-sha');
      expect(md).toContain('bbb');
    });

    it('renders system comments with informational prefix', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'sys-1',
            body: 'added 2 commits',
            author: 'gitlab',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: true,
          },
          {
            id: 'note-1',
            body: 'Fix this',
            author: 'bob',
            createdAt: '2026-01-01T01:00:00Z',
            updatedAt: '2026-01-01T01:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('ℹ️ **System event**');
      expect(md).toContain('2026-01-01T00:00:00Z');
      expect(md).toContain('> gitlab added 2 commits');
      expect(md).toContain('informational context only');
      expect(md).toContain('### bob (human)');
    });

    it('omits diff context when thread has no position', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: undefined,
      };
      await createBundle(manager, makeTarget(), [thread], [makeDiff()]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).not.toContain('## Diff Context');
    });

    it('renders resolved status and resolvable flag in header', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        resolved: true,
        resolvable: false,
        position: undefined,
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **Status**: Resolved');
      expect(md).toContain('- **Resolvable**: false');
    });

    it('renders unresolved status and resolvable true in header', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        resolved: false,
        resolvable: true,
        position: undefined,
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **Status**: Unresolved');
      expect(md).toContain('- **Resolvable**: true');
    });

    it('renders GitHub outdated status and warning when present', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        provider: 'github',
        outdated: true,
        position: undefined,
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **Outdated**: true');
      expect(md).toContain('GitHub marks this thread as outdated');
    });

    it('renders file path and line number from position', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/foo.ts', newLine: 42 },
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **File**: `src/foo.ts`');
      expect(md).toContain('- **Line**: 42');
    });

    it('falls back to oldLine when newLine is absent', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/bar.ts', oldLine: 7 },
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **Line**: 7');
    });

    it('omits line when both newLine and oldLine are absent', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/baz.ts' },
      };
      await createBundle(manager, makeTarget(), [thread], []);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('- **File**: `src/baz.ts`');
      expect(md).not.toContain('- **Line**');
    });
  });

  describe('diffToGitPatch', () => {
    it('adds new file mode header for new files', () => {
      const diff: ReviewDiff = {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        diff: '+content',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).toContain('new file mode 100644');
      expect(patch).not.toContain('deleted file');
    });

    it('adds deleted file mode header for deleted files', () => {
      const diff: ReviewDiff = {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        diff: '-content',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).toContain('deleted file mode 100644');
      expect(patch).not.toContain('new file');
    });

    it('adds rename metadata for renamed files', () => {
      const diff: ReviewDiff = {
        oldPath: 'old.ts',
        newPath: 'new.ts',
        diff: '',
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).toContain('rename from old.ts');
      expect(patch).toContain('rename to new.ts');
    });

    it('emits Binary files marker for empty new file diff', () => {
      const diff: ReviewDiff = {
        oldPath: 'img.png',
        newPath: 'img.png',
        diff: '',
        newFile: true,
        renamedFile: false,
        deletedFile: false,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).toContain('Binary files /dev/null and b/img.png differ');
    });

    it('emits Binary files marker for empty deleted file diff', () => {
      const diff: ReviewDiff = {
        oldPath: 'img.png',
        newPath: 'img.png',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).toContain('Binary files a/img.png and /dev/null differ');
    });

    it('does not emit Binary marker for non-new non-deleted empty diff', () => {
      const diff: ReviewDiff = {
        oldPath: 'a.ts',
        newPath: 'a.ts',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const patch = WorkspaceManager.diffToGitPatch(diff);
      expect(patch).not.toContain('Binary files');
    });
  });

  describe('splitPatchByFile', () => {
    it('splits multi-file patch into sections', () => {
      const patch = [
        'diff --git a/a.ts b/a.ts',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -1,2 +1,3 @@',
        ' line1',
        '+line2',
        'diff --git a/b.ts b/b.ts',
        '--- a/b.ts',
        '+++ b/b.ts',
        '@@ -1 +1,2 @@',
        ' existing',
        '+added',
      ].join('\n');
      const sections = WorkspaceManager.splitPatchByFile(patch);
      expect(sections).toHaveLength(2);
      expect(sections[0]).toContain('a/a.ts');
      expect(sections[0]).not.toContain('a/b.ts');
      expect(sections[1]).toContain('a/b.ts');
      expect(sections[1]).not.toContain('a/a.ts');
    });

    it('returns empty array for empty input', () => {
      expect(WorkspaceManager.splitPatchByFile('')).toEqual([]);
    });

    it('returns single section for single-file patch', () => {
      const patch = 'diff --git a/only.ts b/only.ts\n+content\n';
      const sections = WorkspaceManager.splitPatchByFile(patch);
      expect(sections).toHaveLength(1);
      expect(sections[0]).toContain('only.ts');
    });
  });

  describe('buildInstructionRoute via writeContext', () => {
    it('outputs-only mode when nothing changed', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: 'd',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { targetHeadSha: 'aaa', localHeadSha: 'aaa', threadsDigest: 'd' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('| Mode | Outputs-only follow-up |');
      expect(content).toContain('skip, no thread/reply updates since the last checkpoint');
      expect(content).toContain('skip, no new target code to review proactively');
      expect(content).toContain('skip, no new findings pass is expected');
      expect(content).toContain('skip, no MR/PR-level synthesis pass is expected');
      expect(content).toContain('skip, no code-change summary update is expected');
      expect(content).toContain('Inspect pending outputs');
    });

    it('incremental code review mode when only code changed', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: 'd',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: 'd' },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('| Mode | Incremental code review |');
      expect(content).toContain('| Type | GitLab merge request |');
      expect(content).toContain('`.revpack/instructions/02-thread-replies.md`');
      expect(content).toContain('`.revpack/instructions/03-new-findings-and-anchors.md`');
      expect(content).toContain('Use `.revpack/diffs/incremental.patch` as the primary review surface');
      // Checkpoint-specific guidance
      expect(content).toContain('Target code has changed since the last review checkpoint');
      expect(content).toContain('Focus proactive review on the code changes since the last checkpoint');
      // All instructions required → no "Skipped" section
      expect(content).not.toContain('Skipped this run');
      // Instructions numbered starting from 1
      expect(content).toMatch(/^1\. `\.revpack\/instructions\/01-review-workflow/m);
      // Proactive review guidance includes per-file patches resolved through files.json
      expect(content).toContain(
        'Use `.revpack/diffs/latest.patch`, per-file patch paths listed in `.revpack/diffs/files.json`',
      );
      // Bundle Contents table includes incremental.patch entry
      expect(content).toContain('| `.revpack/diffs/incremental.patch` |');
    });

    it('skips thread-replies when threads exist but no updates since checkpoint', async () => {
      const threads = [makeThread()];
      const { threadIndex } = await createBundle(manager, makeTarget(), threads);
      const contextPath = await manager.writeContext(makeTarget(), threads, [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: 'd',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { targetHeadSha: 'aaa', localHeadSha: 'aaa', threadsDigest: 'd' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('skip, no thread/reply updates since the last checkpoint');
    });

    it('fresh review suggests latest.patch, not incremental.patch', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);
      // No prepareSummary → fresh review → proactiveReview=true but no checkpoint comparison
      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Context file starts with the Review Context heading
      expect(content).toMatch(/^# Review Context/);
      // Reading order step 7 suggests latest.patch (unique wording not in Bundle Contents table)
      expect(content).toContain('for the overall change and cross-file context');
      expect(content).not.toContain('incremental.patch');
      // URL row present (makeTarget has webUrl)
      expect(content).toContain('| URL |');
      // Proactive review reading order includes line-map step
      expect(content).toContain('choose valid review anchors before creating findings');
    });
  });

  describe('writeContext target types', () => {
    it('renders GitHub pull request type correctly', async () => {
      const target: ReviewTarget = {
        ...makeTarget(),
        provider: 'github',
        targetType: 'pull_request',
        targetId: '7',
      };
      const { threadIndex } = await createBundle(manager, target, []);
      const contextPath = await manager.writeContext(target, [], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('GitHub pull request');
      expect(content).toContain('#7');
    });

    it('renders local provider type correctly', async () => {
      const target: ReviewTarget = {
        ...makeTarget(),
        provider: 'local',
        targetType: 'local_review',
        targetId: 'feature/x',
      };
      const { threadIndex } = await createBundle(manager, target, []);
      const contextPath = await manager.writeContext(target, [], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Local Git review');
      // Local provider does not @ prefix the author
      expect(content).toContain('| Author | alice |');
    });

    it('does not include URL row when webUrl is empty', async () => {
      const target: ReviewTarget = { ...makeTarget(), webUrl: '' };
      const { threadIndex } = await createBundle(manager, target, []);
      const contextPath = await manager.writeContext(target, [], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('| URL |');
    });

    it('includes deleted and renamed file tags', async () => {
      const deletedDiff: ReviewDiff = {
        oldPath: 'old.ts',
        newPath: 'old.ts',
        diff: '',
        newFile: false,
        renamedFile: false,
        deletedFile: true,
      };
      const renamedDiff: ReviewDiff = {
        oldPath: 'from.ts',
        newPath: 'to.ts',
        diff: '',
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [], [deletedDiff, renamedDiff]);
      const contextPath = await manager.writeContext(makeTarget(), [], [deletedDiff, renamedDiff], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('deleted');
      expect(content).toContain('renamed');
    });
  });

  describe('writeContext checkpoint summary text', () => {
    it('shows fresh review guidance when no checkpoint', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);
      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        prepareSummary: {
          mode: 'fresh',
          checkpoint: null,
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: null,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('No previous revpack review checkpoint');
      expect(content).toContain('Treat this as a fresh review');
    });

    it('shows no-changes guidance when checkpoint exists but nothing changed', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);
      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'bbb',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: 'd',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: 'd' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: false,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('No target code or thread/reply changes');
      expect(content).toContain('| Target code changed since checkpoint | no |');
    });

    it('shows thread-only guidance when only threads changed', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);
      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'bbb',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: 'old',
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: 'new' },
          comparison: {
            targetCodeChangedSinceCheckpoint: false,
            threadsChangedSinceCheckpoint: true,
            descriptionChangedSinceCheckpoint: false,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('threads or replies have been updated');
    });

    it('shows unknown when threadsChanged and descriptionChanged are null', async () => {
      const { threadIndex } = await createBundle(manager, makeTarget(), []);
      const contextPath = await manager.writeContext(makeTarget(), [], [], threadIndex, {
        prepareSummary: {
          mode: 'refresh',
          checkpoint: {
            source: 'description_body',
            headSha: 'aaa',
            baseSha: 'x',
            startSha: 'x',
            threadsDigest: null,
            descriptionDigest: null,
            threadDigests: {},
            createdAt: '2026-01-01T00:00:00Z',
          },
          current: { providerVersionId: 'v1', targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
          comparison: {
            targetCodeChangedSinceCheckpoint: true,
            threadsChangedSinceCheckpoint: null,
            descriptionChangedSinceCheckpoint: null,
          },
        },
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Threads/replies changed since checkpoint | unknown');
      expect(content).toContain('Description changed since checkpoint | unknown');
    });
  });

  describe('writeContext cleanSnippet logic', () => {
    it('strips revpack marker and shows meaningful line in thread table', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'bot-1',
            body: '<!-- revpack -->\n_🔴 High_ | _security_\nActual finding text here',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // The snippet should skip the marker and badge line, showing the actual text
      expect(content).toContain('Actual finding text here');
      // Should NOT contain the severity badge as the snippet
      expect(content).not.toMatch(/\| _🔴 High_ \| _security_/);
    });

    it('truncates long snippets in thread tables', async () => {
      const longBody = 'A'.repeat(200);
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'n1',
            body: longBody,
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Table should have truncated snippet (max 80 chars)
      expect(content).not.toContain('A'.repeat(81));
    });

    it('shows thread location with file path and line number', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/main.ts', newLine: 42 },
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('`src/main.ts`:42');
    });

    it('shows file path without line when position has no line numbers', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/config.ts' },
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('`src/config.ts`');
      expect(content).not.toContain('`src/config.ts`:');
    });

    it('uses oldLine fallback for thread location when newLine is absent', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/old.ts', oldLine: 7 },
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('`src/old.ts`:7');
    });

    it('shows general for threads without position', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        position: undefined,
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('| general |');
    });
  });

  describe('per-file patch writing', () => {
    it('writes patch files with correct naming convention', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/my-service.ts',
        newPath: 'src/my-service.ts',
        diff: '@@ -1,2 +1,3 @@\n line1\n+line2\n line3\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      expect(files).toContain('F001-my-service.patch');
      const patchContent = await fs.readFile(path.join(patchDir, 'F001-my-service.patch'), 'utf-8');
      expect(patchContent).toContain('diff --git');
      expect(patchContent.endsWith('\n')).toBe(true);
      // Should have exactly one trailing newline (trimEnd + \n)
      expect(patchContent.endsWith('\n\n')).toBe(false);
    });

    it('sanitizes special characters in patch file names', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/weird file (copy).ts',
        newPath: 'src/weird file (copy).ts',
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      // Special chars replaced, only alphanumeric, _, - remain
      expect(files[0]).toMatch(/^F001-[a-zA-Z0-9_-]+\.patch$/);
    });

    it('replaces stale per-file artifacts and removes legacy diff artifacts when bundle is recreated', async () => {
      const makeFileDiff = (fileName: string): ReviewDiff => ({
        oldPath: `src/${fileName}.ts`,
        newPath: `src/${fileName}.ts`,
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      });

      await createBundle(manager, makeTarget(), [], [makeFileDiff('first'), makeFileDiff('second')]);

      const diffDir = path.join(tmpDir, '.revpack', 'diffs');
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const anchorMapDir = path.join(diffDir, 'anchor-maps');
      expect((await fs.readdir(patchDir)).sort()).toEqual(['F001-first.patch', 'F002-second.patch']);
      expect((await fs.readdir(anchorMapDir)).sort()).toEqual(['F001-first.ndjson', 'F002-second.ndjson']);
      await fs.writeFile(path.join(diffDir, 'line-map.ndjson'), 'legacy\n', 'utf-8');
      await fs.writeFile(path.join(diffDir, 'change-blocks.json'), '{}\n', 'utf-8');

      await createBundle(manager, makeTarget(), [], [makeFileDiff('second')]);

      expect((await fs.readdir(patchDir)).sort()).toEqual(['F001-second.patch']);
      expect((await fs.readdir(anchorMapDir)).sort()).toEqual(['F001-second.ndjson']);
      await expect(fs.access(path.join(diffDir, 'line-map.ndjson'))).rejects.toThrow();
      await expect(fs.access(path.join(diffDir, 'change-blocks.json'))).rejects.toThrow();
    });
  });

  describe('clearThreadFiles', () => {
    it('removes old thread files when bundle is recreated', async () => {
      const thread1 = makeThread();
      const thread2 = { ...makeThread(), threadId: 'thread-2', comments: thread1.comments };
      await createBundle(manager, makeTarget(), [thread1, thread2]);

      const threadDir = path.join(tmpDir, '.revpack', 'threads');
      expect((await fs.readdir(threadDir)).filter((f) => f.endsWith('.json'))).toHaveLength(2);

      // Recreate with only one thread - old files should be cleared
      await createBundle(manager, makeTarget(), [thread1]);
      const files = (await fs.readdir(threadDir)).filter((f) => f.endsWith('.json'));
      expect(files).toHaveLength(1);
    });
  });

  describe('cleanSnippet regex coverage', () => {
    // cleanSnippet is exercised through writeContext thread tables.
    // These tests target specific regex mutation survivors.

    it('skips empty lines to find first meaningful line', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '\n\n\nActual meaningful content',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Empty lines should be skipped, showing the first non-empty line
      expect(content).toContain('Actual meaningful content');
    });

    it('skips badge line with leading whitespace', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n  _High_ | _security_\nActual content here',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Badge line with leading spaces should still be trimmed and skipped
      expect(content).toContain('Actual content here');
      expect(content).not.toContain('_High_');
    });

    it('does not strip marker that appears mid-line (^ anchor)', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: 'prefix text <!-- revpack -->\nContent after',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // The ^ anchor means the marker only matches at start; mid-line marker preserved as meaningful content
      expect(content).toContain('prefix text <!-- revpack -->');
    });

    it('strips marker preceded by multiple whitespace chars', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '   <!-- revpack -->\nReal content here',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Multiple whitespace before marker should still be stripped (\s*)
      expect(content).toContain('Real content here');
      expect(content).not.toContain('<!-- revpack -->');
    });

    it('strips marker with trailing whitespace before newline', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->   \nTrailing ws content',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Trailing ws content');
    });

    it('strips marker without trailing newline', async () => {
      // Body is just "<!-- revpack -->Content" with no newline between
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->Content on same line',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // \n? means newline is optional - content right after marker should be found
      expect(content).toContain('Content on same line');
      // Marker itself should be stripped from the snippet
      expect(content).not.toMatch(/<!-- revpack -->Content/);
    });

    it('returns empty snippet when body has only badges and empty lines', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n_🔴 High_ | _security_\n\n_Low_\n',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // All non-empty lines are badge patterns - meaningful is undefined, returns ''
      // The table row should have empty snippet cell
      const threadTable = content.split('## Unresolved Threads')[1]?.split('##')[0] ?? '';
      const dataRows = threadTable.split('\n').filter((l) => l.startsWith('|') && !l.includes('---'));
      // Last cell should be empty (just spaces between pipes)
      const lastRow = dataRows[dataRows.length - 1] ?? '';
      const cells = lastRow.split('|').map((c) => c.trim());
      expect(cells[cells.length - 2]).toBe(''); // snippet cell is empty
    });

    it('trims whitespace from meaningful line', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n   Padded content   ',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // .trim() should remove whitespace around the meaningful line
      expect(content).toContain('Padded content');
      expect(content).not.toContain('   Padded');
    });

    it('does not skip non-badge lines that contain underscores', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n_badge_ | _cat_\n_bold_ some text after',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // "_bold_ some text after" doesn't match the badge-only regex (has text after)
      expect(content).toContain('_bold_ some text after');
    });

    it('skips single badge without pipe separator', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n_Medium_\nThe real finding',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // Single badge "_Medium_" matches /^_[^_]+_(\s*\|\s*_[^_]+_)*\s*$/ with zero repetitions
      expect(content).toContain('The real finding');
      expect(content).not.toMatch(/\| _Medium_ \|/);
    });

    it('skips triple-badge line with multiple pipes', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n_🔴 High_ | _security_ | _urgent_\nActual issue',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('Actual issue');
    });

    it('skips badges with no spaces around pipe separator', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\n_🔴 High_|_security_\nReal finding text',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // \s* allows zero spaces around pipe - badge still detected
      expect(content).toContain('Real finding text');
      expect(content).not.toContain('_🔴 High_|_security_');
    });

    it('does not skip line containing badge-like text after prefix text', async () => {
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '<!-- revpack -->\nSee _High_\nFallback',
            author: 'bot',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'bot',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // ^ anchor requires line to START with underscore - "See _High_" has prefix text
      expect(content).toContain('See _High_');
    });

    it('trims lines before badge detection so leading-whitespace badges are skipped', async () => {
      // Body without <!-- revpack --> marker — the trim on the find predicate matters
      const thread: ReviewThread = {
        ...makeThread(),
        comments: [
          {
            id: 'c1',
            body: '  _High_ | _security_\nActual finding',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex);
      const content = await fs.readFile(contextPath, 'utf-8');
      // The whitespace-prefixed badge line should be trimmed and detected as badge, not used as snippet
      expect(content).toContain('Actual finding');
      expect(content).not.toMatch(/\|\s*_High_/);
    });
  });

  describe('extractDiffContext boundary conditions', () => {
    it('shows all lines when thread is at the first line of diff', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: ['@@ -1,4 +1,4 @@', '+newFirst', ' line2', ' line3', ' line4'].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 1 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      const diffBlock = md.split('```diff')[1].split('```')[0];
      // lineIdx=0, start=max(0,0-3)=0, end=min(3,0+1)=1
      // Should show at most 2 lines: the target + 1 below
      expect(diffBlock).toContain('newFirst');
      expect(diffBlock).toContain('◀');
      expect(diffBlock).toContain('line2');
    });

    it('shows context when thread is at the last line of diff', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: ['@@ -1,4 +1,4 @@', ' line1', ' line2', ' line3', '+lastLine'].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 4 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      const diffBlock = md.split('```diff')[1].split('```')[0];
      // lineIdx=3 (last), start=max(0,3-3)=0, end=min(3,3+1)=3
      expect(diffBlock).toContain('lastLine');
      expect(diffBlock).toContain('◀');
      // All 3 context lines above should be shown
      expect(diffBlock).toContain('line1');
      expect(diffBlock).toContain('line2');
      expect(diffBlock).toContain('line3');
    });

    it('formats removed lines with - prefix and correct line numbers', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: ['@@ -5,3 +5,2 @@', ' keep', '-deleted', ' after'].join('\n'),
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', oldLine: 6 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      const diffBlock = md.split('```diff')[1].split('```')[0];
      const lines = diffBlock.split('\n').filter((l) => l.length > 0);
      // Removed line should have - prefix at position 0
      const removedLine = lines.find((l) => l.includes('deleted'));
      expect(removedLine).toBeDefined();
      expect(removedLine![0]).toBe('-');
      expect(removedLine).toContain('◀');
      // Removed line uses oldLine number since newLine is undefined
      expect(removedLine).toContain('6');
      // Context line should have space prefix at position 0
      const contextLine = lines.find((l) => l.includes('keep'));
      expect(contextLine).toBeDefined();
      expect(contextLine![0]).toBe(' ');
      // Context line shows its line number
      expect(contextLine).toContain('5');
      // After line is also context
      const afterLine = lines.find((l) => l.includes('after'));
      expect(afterLine).toBeDefined();
      expect(afterLine![0]).toBe(' ');
    });

    it('returns no diff context when position does not match any line', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.ts',
        newPath: 'src/app.ts',
        diff: '@@ -1,2 +1,2 @@\n line1\n+line2\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 999 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      // No diff context section when line not found
      expect(md).not.toContain('## Diff Context');
    });

    it('returns no diff context when position file does not match diff paths', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/other.ts',
        newPath: 'src/other.ts',
        diff: '@@ -1,2 +1,2 @@\n line1\n+line2\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/app.ts', newLine: 1 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).not.toContain('## Diff Context');
    });

    it('uses newPath matching for file lookup', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/old-name.ts',
        newPath: 'src/new-name.ts',
        diff: '@@ -1,2 +1,2 @@\n context\n+added\n',
        newFile: false,
        renamedFile: true,
        deletedFile: false,
      };
      const thread: ReviewThread = {
        ...makeThread(),
        position: { filePath: 'src/new-name.ts', newLine: 2 },
      };
      await createBundle(manager, makeTarget(), [thread], [diff]);

      const md = await fs.readFile(path.join(tmpDir, '.revpack', 'threads', 'T-001.md'), 'utf-8');
      expect(md).toContain('## Diff Context');
      expect(md).toContain('added');
    });
  });

  describe('per-file patch naming edge cases', () => {
    it('truncates long filenames to 40 characters', async () => {
      const longName = 'a-very-long-component-name-that-exceeds-the-limit.ts';
      const diff: ReviewDiff = {
        oldPath: `src/${longName}`,
        newPath: `src/${longName}`,
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      // safeName is sliced to 40 chars
      const safePart = files[0].replace(/^F\d+-/, '').replace('.patch', '');
      expect(safePart.length).toBeLessThanOrEqual(40);
    });

    it('sanitizes special characters in filenames', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app[dev].ts',
        newPath: 'src/app[dev].ts',
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      // Brackets should be replaced with underscores
      expect(files[0]).toContain('app_dev_');
      expect(files[0]).not.toContain('[');
      expect(files[0]).not.toContain(']');
    });

    it('matches files.json naming when filename has no basename after extension removal', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/.gitignore',
        newPath: 'src/.gitignore',
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      // .gitignore -> pop() = '.gitignore', replace(/\.[^.]+$/, '') = ''
      expect(files[0]).toBe('F001-.patch');
    });

    it('strips only the final extension from multi-dot filenames', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.module.ts',
        newPath: 'src/app.module.ts',
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const patchDir = path.join(tmpDir, '.revpack', 'diffs', 'patches', 'by-file');
      const files = await fs.readdir(patchDir);
      // 'app.module.ts' → strip '.ts' → 'app.module' → sanitize dots → 'app_module'
      expect(files[0]).toContain('app_module');
    });

    it('files.json patchFile uses correctly sanitized multi-dot name', async () => {
      const diff: ReviewDiff = {
        oldPath: 'src/app.spec.ts',
        newPath: 'src/app.spec.ts',
        diff: '@@ -1 +1,2 @@\n line\n+added\n',
        newFile: false,
        renamedFile: false,
        deletedFile: false,
      };
      await createBundle(manager, makeTarget(), [], [diff]);
      const filesJson = JSON.parse(await fs.readFile(path.join(tmpDir, '.revpack', 'diffs', 'files.json'), 'utf-8'));
      // strip last extension only: 'app.spec.ts' → 'app.spec' → sanitize → 'app_spec'
      expect(filesJson.files[0].patchFile).toContain('app_spec');
      expect(filesJson.files[0].patchFile).not.toContain('app_spec_');
    });
  });

  describe('changed threads section in writeContext', () => {
    it('lists unresolved changed threads and excludes resolved changed threads', async () => {
      const unresolvedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'changed-unresolved',
        resolved: false,
        position: { filePath: 'src/a.ts', newLine: 5 },
      };
      const resolvedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'changed-resolved',
        resolved: true,
        position: { filePath: 'src/b.ts', newLine: 10 },
      };
      const unchangedThread: ReviewThread = {
        ...makeThread(),
        threadId: 'unchanged',
        resolved: false,
      };
      const allThreads = [unresolvedThread, resolvedThread, unchangedThread];
      const { threadIndex } = await createBundle(manager, makeTarget(), allThreads);
      const contextPath = await manager.writeContext(makeTarget(), allThreads, [], threadIndex, {
        changedThreadIds: new Set(['changed-unresolved', 'changed-resolved']),
        allThreads,
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).toContain('## Changed Threads Since Last Checkpoint');
      expect(content).toContain('unresolved');
      expect(content).toContain('`src/a.ts`:5');
      expect(content).not.toContain('`src/b.ts`:10');
      const changedSection = content.split('## Changed Threads Since Last Checkpoint')[1]?.split('##')[0] ?? '';
      expect(changedSection).not.toContain('| T-002 | resolved |');
      const dataRows = changedSection
        .split('\n')
        .filter((l) => l.startsWith('|') && !l.includes('---') && !l.includes('Thread'));
      expect(dataRows).toHaveLength(1);
    });

    it('omits section when no changed thread IDs match any thread', async () => {
      const thread: ReviewThread = { ...makeThread(), threadId: 'normal' };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex, {
        changedThreadIds: new Set(['nonexistent-id']),
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Changed Threads Since Last Checkpoint');
    });

    it('omits section when changedThreadIds is empty', async () => {
      const thread: ReviewThread = { ...makeThread() };
      const { threadIndex } = await createBundle(manager, makeTarget(), [thread]);
      const contextPath = await manager.writeContext(makeTarget(), [thread], [], threadIndex, {
        changedThreadIds: new Set(),
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      expect(content).not.toContain('## Changed Threads Since Last Checkpoint');
    });

    it('uses allThreads for filtering when provided', async () => {
      const visibleThread: ReviewThread = { ...makeThread(), threadId: 'visible' };
      const hiddenThread: ReviewThread = {
        ...makeThread(),
        threadId: 'hidden-changed',
        resolved: false,
        comments: [
          {
            id: 'h1',
            body: 'Hidden thread body content xyz',
            author: 'reviewer',
            createdAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            origin: 'human',
            system: false,
          },
        ],
      };
      // Pass only visibleThread as the "threads" arg, but hiddenThread in allThreads
      const { threadIndex } = await createBundle(manager, makeTarget(), [visibleThread, hiddenThread]);
      const contextPath = await manager.writeContext(makeTarget(), [visibleThread], [], threadIndex, {
        changedThreadIds: new Set(['hidden-changed']),
        allThreads: [visibleThread, hiddenThread],
      });
      const content = await fs.readFile(contextPath, 'utf-8');
      // hiddenThread should appear in changed threads table via allThreads
      expect(content).toContain('Hidden thread body content xyz');
    });
  });
});

// ─── Test helpers ─────────────────────────────────────────

function makePrepareSummary(): PrepareSummary {
  return {
    mode: 'fresh',
    checkpoint: null,
    current: { targetHeadSha: 'bbb', localHeadSha: 'bbb', threadsDigest: null },
    comparison: {
      targetCodeChangedSinceCheckpoint: null,
      threadsChangedSinceCheckpoint: null,
      descriptionChangedSinceCheckpoint: null,
    },
  };
}

function makeLocal(): BundleLocal {
  return {
    repositoryRoot: '/tmp/test',
    branch: 'feature/test',
    headSha: 'bbb',
    matchesTargetSourceBranch: true,
    matchesTargetHead: true,
    checkedAt: '2026-01-01T00:00:00Z',
  };
}

/** Create bundle + save state for tests that need bundle.json to exist */
async function createBundleWithState(m: WorkspaceManager) {
  const target = makeTarget();
  const threadIndex = WorkspaceManager.buildThreadIndex([]);
  await m.createBundle(target, [], [], [], threadIndex);
  const state = m.buildBundleState(target, [], [], threadIndex, makePrepareSummary(), makeLocal());
  await m.saveBundleState(state);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}
