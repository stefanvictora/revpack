import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { stripVTControlCharacters } from 'node:util';
import {
  createNodePublishTerminal,
  runGuidedPublish,
  runStalePublishPrompt,
  type GuidedPublishModel,
  type PublishTerminal,
  type PublishTerminalKey,
} from './publish-tui.js';

class FakeTerminal implements PublishTerminal {
  interactive = true;
  frames: string[] = [];
  starts = 0;
  stops = 0;

  constructor(
    private readonly keys: PublishTerminalKey[],
    private readonly size = { columns: 120, rows: 30 },
  ) {}

  dimensions(): { columns: number; rows: number } {
    return this.size;
  }

  start(): void {
    this.starts += 1;
  }

  stop(): void {
    this.stops += 1;
  }

  readKey(): Promise<PublishTerminalKey> {
    const key = this.keys.shift();
    if (!key) return Promise.reject(new Error('Fake terminal ran out of keys.'));
    return Promise.resolve(key);
  }

  writeFrame(frame: string): void {
    this.frames.push(frame);
  }
}

function guidedModel(overrides: Partial<GuidedPublishModel> = {}): GuidedPublishModel {
  return {
    provider: 'gitlab',
    findings: [
      {
        index: 4,
        value: {
          oldPath: 'src/old.ts',
          newPath: 'src/new.ts',
          newLine: 17,
          body: 'The complete finding body.',
          severity: 'high',
          category: 'correctness',
        },
      },
      {
        index: 9,
        value: {
          oldPath: 'src/other.ts',
          newPath: 'src/other.ts',
          oldLine: 5,
          body: 'Another finding.',
          severity: 'low',
          category: 'testing',
        },
      },
    ],
    replies: [
      {
        index: 3,
        value: { threadId: 'T-001', body: 'The complete draft reply.', resolve: true },
      },
    ],
    replyContexts: new Map(),
    summary: { state: 'pending', content: 'Complete summary.' },
    note: { content: 'Complete review note.' },
    checkpoint: { state: 'outdated', targetHeadSha: '1234567890abcdef' },
    ...overrides,
  };
}

describe('guided publish TUI', () => {
  it('starts with every pending item and a due checkpoint selected', async () => {
    const terminal = new FakeTerminal(['enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection).toEqual({
      findingIndexes: [4, 9],
      replyIndexes: [3],
      summary: true,
      note: true,
      checkpoint: true,
    });
  });

  it('keeps empty categories visible and disabled', async () => {
    const terminal = new FakeTerminal(['escape']);

    await runGuidedPublish(
      guidedModel({
        findings: [],
        summary: { state: 'empty', content: '' },
        note: { content: '   ' },
        checkpoint: { state: 'current', targetHeadSha: '1234567890abcdef' },
      }),
      terminal,
    );

    expect(terminal.frames[0]).toContain('[ ] Findings — none');
    expect(terminal.frames[0]).toContain('[x] Replies — 1/1 selected');
    expect(terminal.frames[0]).toContain('[ ] Summary — none');
    expect(terminal.frames[0]).toContain('[ ] Review note — none');
    expect(terminal.frames[0]).toContain('[ ] Checkpoint — current');
  });

  it('toggles one finding, shows a mixed group, and turns checkpoint off', async () => {
    const terminal = new FakeTerminal(['space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames.some((frame) => frame.includes('[-] Findings — 1/2 selected'))).toBe(true);
    expect(selection).toEqual({
      findingIndexes: [9],
      replyIndexes: [3],
      summary: true,
      note: true,
      checkpoint: false,
    });
  });

  it('toggles every finding with Space on the group header', async () => {
    const terminal = new FakeTerminal(['up', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames.some((frame) => frame.includes('[ ] Findings — 0/2 selected'))).toBe(true);
    expect(selection?.findingIndexes).toEqual([]);
    expect(selection?.replyIndexes).toEqual([3]);
    expect(selection?.checkpoint).toBe(false);
  });

  it('uses a to toggle the group containing the focused item', async () => {
    const terminal = new FakeTerminal(['toggle-group', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.findingIndexes).toEqual([]);
    expect(selection?.replyIndexes).toEqual([3]);
    expect(terminal.frames.at(-2)).toContain('a toggle group');
  });

  it('clears the Replies group without changing Findings', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.replyIndexes).toEqual([]);
    expect(selection?.findingIndexes).toEqual([4, 9]);
    expect(selection?.checkpoint).toBe(false);
    expect(terminal.frames.some((frame) => frame.includes('[ ] Replies — 0/1 selected'))).toBe(true);
  });

  it('can reselect the Replies group without automatically re-enabling the checkpoint', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'space', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.replyIndexes).toEqual([3]);
    expect(selection?.findingIndexes).toEqual([4, 9]);
    expect(selection?.checkpoint).toBe(false);
  });

  it('advertises Ctrl+C cancellation in the selection footer', async () => {
    const terminal = new FakeTerminal(['escape']);

    await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames[0]).toContain('Ctrl+C cancel');
  });

  it('selects replies independently from findings', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'down', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.findingIndexes).toEqual([4, 9]);
    expect(selection?.replyIndexes).toEqual([]);
    expect(selection?.checkpoint).toBe(false);
  });

  it('does not automatically re-enable checkpoint after material is reselected', async () => {
    const terminal = new FakeTerminal(['space', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.findingIndexes).toEqual([4, 9]);
    expect(selection?.checkpoint).toBe(false);
  });

  it('warns when checkpoint is explicitly enabled with a deferred draft', async () => {
    const terminal = new FakeTerminal([
      'space',
      'down',
      'down',
      'down',
      'down',
      'down',
      'down',
      'space',
      'enter',
      'enter',
    ]);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.checkpoint).toBe(true);
    expect(selection?.findingIndexes).toEqual([9]);
    expect(terminal.frames.at(-1)).toContain(
      'Warning: the checkpoint will be recorded while 1 draft remains unpublished.',
    );
  });

  it('names an unselected document when checkpoint is explicitly enabled', async () => {
    const terminal = new FakeTerminal([
      'down',
      'down',
      'down',
      'down',
      'space',
      'down',
      'down',
      'space',
      'enter',
      'enter',
    ]);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.summary).toBe(false);
    expect(selection?.checkpoint).toBe(true);
    expect(terminal.frames.at(-1)).toContain('Summary will remain unpublished.');
    expect(terminal.frames.at(-1)).toContain(
      'Warning: the checkpoint will be recorded while Summary remains unpublished.',
    );
  });

  it('cancels without returning a selection and always closes the terminal', async () => {
    const terminal = new FakeTerminal(['escape']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection).toBeNull();
    expect(terminal.starts).toBe(1);
    expect(terminal.stops).toBe(1);
  });

  it('confirms the exact selected material and deferred drafts', async () => {
    const terminal = new FakeTerminal(['space', 'enter', 'enter']);

    await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames.at(-1)).toContain('Publish:\n\n  1 finding\n  1 reply\n  Summary\n  Review note');
    expect(terminal.frames.at(-1)).not.toContain('  Checkpoint');
    expect(terminal.frames.at(-1)).toContain('1 finding will remain as a draft.');
    expect(terminal.frames.at(-1)).toContain('Enter publish    Esc back');
  });

  it('previews complete finding metadata and publishable body', async () => {
    const terminal = new FakeTerminal(['escape']);

    await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames[0]).toContain('HIGH · correctness');
    expect(terminal.frames[0]).toContain('Old path: src/old.ts');
    expect(terminal.frames[0]).toContain('New path: src/new.ts');
    expect(terminal.frames[0]).toContain('Position: new line 17');
    expect(terminal.frames[0]).toContain('Finding body — will be published');
    expect(terminal.frames[0]).toContain('The complete finding body.');
  });

  it('marks an unselected finding preview as deferred', async () => {
    const terminal = new FakeTerminal(['space', 'escape']);

    await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames.at(-1)).toContain('Finding body — deferred');
    expect(terminal.frames.at(-1)).not.toContain('Finding body — will be published');
  });

  it('separates resolved thread context from a reply and shows resolution intent', async () => {
    const replyContexts = new Map([
      [
        3,
        {
          provider: 'gitlab' as const,
          targetRef: {
            provider: 'gitlab' as const,
            repository: 'group/project',
            targetType: 'merge_request' as const,
            targetId: '42',
          },
          threadId: 'provider-thread-1',
          resolved: true,
          resolvable: true,
          position: { filePath: 'src/reply.ts', newLine: 21 },
          comments: [
            {
              id: 'comment-1',
              body: 'Original reviewer context in full.',
              author: 'reviewer',
              createdAt: '2026-07-01T00:00:00Z',
              updatedAt: '2026-07-01T00:00:00Z',
              origin: 'human' as const,
              system: false,
            },
          ],
        },
      ],
    ]);
    const terminal = new FakeTerminal(['down', 'down', 'down', 'escape']);

    await runGuidedPublish(guidedModel({ replyContexts }), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Thread context — not published');
    expect(frame).toContain('Thread state: resolved');
    expect(frame).toContain('reviewer: Original reviewer context in full.');
    expect(frame).toContain('Draft reply — will be published');
    expect(frame).toContain('The complete draft reply.');
    expect(frame).toContain('Publishing this reply will resolve the thread.');
  });

  it('marks an unselected reply as deferred without promising a thread change', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'down', 'space', 'escape']);

    await runGuidedPublish(guidedModel(), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Draft reply — deferred');
    expect(frame).toContain('This reply will remain as a draft; the thread will not be changed.');
    expect(frame).not.toContain('Publishing this reply will resolve the thread.');
  });

  it('previews the complete managed summary content', async () => {
    const content = '# Review summary\n\nComplete summary details.\n\n```ts\nconst kept = true;\n```';
    const terminal = new FakeTerminal(['down', 'down', 'down', 'down', 'escape']);

    await runGuidedPublish(guidedModel({ summary: { state: 'modified since publish', content } }), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Updates the managed PR/MR description section.');
    expect(frame).toContain('# Review summary');
    expect(frame).toContain('Complete summary details.');
    expect(frame).toContain('```ts');
    expect(frame).toContain('const kept = true;');
    expect(frame).toContain('```');
  });

  it('marks an unselected summary preview as unpublished', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'down', 'down', 'space', 'escape']);

    await runGuidedPublish(guidedModel(), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Summary — will remain unpublished');
    expect(frame).toContain('The managed PR/MR description section will not be updated.');
    expect(frame).not.toContain('Updates the managed PR/MR description section.');
  });

  it('previews a complete review note with GitHub batch delivery', async () => {
    const content = 'Complete target note.\n\nHandover: keep this final prompt.';
    const terminal = new FakeTerminal(['down', 'down', 'down', 'down', 'down', 'escape']);

    await runGuidedPublish(guidedModel({ provider: 'github', note: { content } }), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Included in the GitHub review batch with selected findings.');
    expect(frame).toContain('Complete target note.');
    expect(frame).toContain('Handover: keep this final prompt.');
  });

  it('does not promise GitHub batch delivery for an unselected review note', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'down', 'down', 'down', 'space', 'escape']);

    await runGuidedPublish(guidedModel({ provider: 'github' }), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Review note — will remain unpublished');
    expect(frame).not.toContain('Included in the GitHub review batch');
    expect(frame).not.toContain('Creates a target-level review note.');
  });

  it('uses target-level note delivery when no GitHub findings are selected', async () => {
    const terminal = new FakeTerminal(['down', 'down', 'escape']);

    await runGuidedPublish(guidedModel({ provider: 'github', findings: [] }), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Review note — will be published');
    expect(frame).toContain('Creates a target-level review note.');
    expect(frame).not.toContain('Included in the GitHub review batch');
  });

  it('previews checkpoint state, target head, recorded state, and deferred-draft warning', async () => {
    const terminal = new FakeTerminal(['space', 'down', 'down', 'down', 'down', 'down', 'down', 'space', 'escape']);

    await runGuidedPublish(guidedModel(), terminal);

    const frame = terminal.frames.at(-1)!;
    expect(frame).toContain('Current checkpoint state: outdated');
    expect(frame).toContain('Target head: 12345678');
    expect(frame).toContain('Will record the reviewed target head and current review state.');
    expect(frame).toContain('Drafts that will remain: 1');
    expect(frame).toContain('Warning: the checkpoint will be recorded while 1 draft remains unpublished.');
  });

  it('neutralizes terminal control sequences in every preview source while preserving safe newlines', async () => {
    const escape = String.fromCharCode(27);
    const csi = `${escape}[2J`;
    const osc = `${escape}]0;owned${String.fromCharCode(7)}`;
    const c1Csi = `${String.fromCharCode(0x9b)}31m`;
    const poison = `${csi}${osc}${String.fromCharCode(8)}${c1Csi}\r`;
    const findings = [
      {
        index: 4,
        value: {
          oldPath: `old${poison}-safe.ts`,
          newPath: `new${poison}-safe.ts`,
          newLine: 17,
          body: `finding line one\nfinding ${poison}line two`,
          severity: 'high' as const,
          category: `correct${poison}ness`,
        },
      },
    ];
    const replies = [
      {
        index: 3,
        value: {
          threadId: `T-${poison}safe`,
          body: `reply line one\nreply ${poison}line two`,
          resolve: false,
        },
      },
    ];
    const baseContext = {
      provider: 'gitlab' as const,
      targetRef: {
        provider: 'gitlab' as const,
        repository: 'group/project',
        targetType: 'merge_request' as const,
        targetId: '42',
      },
      threadId: 'provider-thread-1',
      resolved: false,
      resolvable: true,
      position: { filePath: `context${poison}-safe.ts`, newLine: 21 },
      comments: [
        {
          id: 'comment-1',
          body: `context ${poison}safe`,
          author: `review${poison}er`,
          createdAt: '2026-07-01T00:00:00Z',
          updatedAt: '2026-07-01T00:00:00Z',
          origin: 'human' as const,
          system: false,
        },
      ],
    };
    const terminal = new FakeTerminal(['down', 'down', 'down', 'down', 'escape'], { columns: 80, rows: 40 });

    await runGuidedPublish(
      guidedModel({
        findings,
        replies,
        replyContexts: new Map([[3, baseContext]]),
        summary: { state: 'pending', content: `summary line one\nsummary ${poison}line two` },
        note: { content: `note line one\nnote ${poison}line two` },
      }),
      terminal,
    );

    const output = terminal.frames.join('\n');
    expect(output).not.toContain(csi);
    expect(output).not.toContain(osc);
    expect(output).not.toContain(c1Csi);
    expect(output).not.toContain(String.fromCharCode(8));
    expect(output).not.toContain('\r');
    expect(output).toContain('HIGH · correctness');
    expect(output).toContain('Old path: old-safe.ts');
    expect(output).toContain('Reply T-safe');
    expect(output).toContain('reviewer: context safe');
    expect(terminal.frames[3]).toContain('summary line one\nsummary line two');
    expect(terminal.frames[4]).toContain('note line one\nnote line two');
  });

  it('renders the list and preview side by side on a wide terminal', async () => {
    const terminal = new FakeTerminal(['escape'], { columns: 120, rows: 30 });

    await runGuidedPublish(guidedModel(), terminal);

    expect(terminal.frames[0].split('\n')[0]).toMatch(/^Review material\s+│ Preview$/);
    expect(terminal.frames[0]).toContain('HIGH · correctness');
  });

  it('stacks the preview below the list on a narrow terminal', async () => {
    const terminal = new FakeTerminal(['escape'], { columns: 64, rows: 30 });

    await runGuidedPublish(guidedModel(), terminal);

    const lines = terminal.frames[0].split('\n');
    expect(lines[0]).toBe('Review material');
    expect(lines.indexOf('Preview')).toBeGreaterThan(lines.indexOf('Review state'));
    expect(terminal.frames[0]).toContain('The complete finding body.');
  });

  it('keeps narrow physical lines within the terminal while retaining the complete scrollable preview', async () => {
    const baseFinding = guidedModel().findings[0];
    const terminal = new FakeTerminal([...Array.from({ length: 20 }, () => 'page-down' as const), 'escape'], {
      columns: 36,
      rows: 18,
    });

    await runGuidedPublish(
      guidedModel({
        findings: [
          {
            ...baseFinding,
            value: {
              ...baseFinding.value,
              oldPath: `src/${'old-path-'.repeat(8)}file.ts`,
              newPath: `src/${'new-path-'.repeat(8)}file.ts`,
              category: `correctness-${'long-'.repeat(8)}category`,
              body: `${'complete preview words '.repeat(12)}\nTAIL_OF_COMPLETE_PREVIEW`,
            },
          },
        ],
      }),
      terminal,
    );

    for (const frame of terminal.frames) {
      for (const line of frame.split('\n')) {
        expect(stripVTControlCharacters(line).length).toBeLessThanOrEqual(36);
      }
    }
    expect(terminal.frames[0]).not.toContain('TAIL_OF_COMPLETE_PREVIEW');
    expect(terminal.frames.at(-1)).toContain('TAIL_OF_COMPLETE_PREVIEW');
  });

  it('scrolls a long list while keeping the highlighted item visible', async () => {
    const findings = Array.from({ length: 12 }, (_, index) => ({
      index,
      value: {
        oldPath: `src/file-${index}.ts`,
        newPath: `src/file-${index}.ts`,
        newLine: index + 1,
        body: `Finding number ${index}`,
        severity: 'medium' as const,
        category: 'correctness',
      },
    }));
    const terminal = new FakeTerminal([...Array.from({ length: 11 }, () => 'down' as const), 'escape'], {
      columns: 120,
      rows: 12,
    });

    await runGuidedPublish(guidedModel({ findings }), terminal);

    expect(terminal.frames[0]).not.toContain('src/file-11.ts:12');
    expect(terminal.frames.at(-1)).toContain('> [x] src/file-11.ts:12');
    expect(terminal.frames.at(-1)).not.toContain('src/file-0.ts:1');
  });

  it('scrolls a long preview independently with Page Down', async () => {
    const body = Array.from({ length: 20 }, (_, index) => `body-line-${String(index + 1).padStart(2, '0')}`).join('\n');
    const findings = [
      {
        ...guidedModel().findings[0],
        value: { ...guidedModel().findings[0].value, body },
      },
    ];
    const terminal = new FakeTerminal(['page-down', 'page-down', 'page-down', 'page-down', 'escape'], {
      columns: 120,
      rows: 12,
    });

    await runGuidedPublish(guidedModel({ findings }), terminal);

    expect(terminal.frames[0]).not.toContain('body-line-15');
    expect(terminal.frames.at(-1)).toContain('body-line-15');
    expect(terminal.frames.at(-1)).toContain('> [x] src/new.ts:17');
  });

  it('scrolls back from the end of a preview with Page Up', async () => {
    const body = Array.from({ length: 20 }, (_, index) => `body-line-${String(index + 1).padStart(2, '0')}`).join('\n');
    const baseFinding = guidedModel().findings[0];
    const terminal = new FakeTerminal(
      [...Array.from({ length: 20 }, () => 'page-down' as const), 'page-up', 'escape'],
      { columns: 120, rows: 12 },
    );

    await runGuidedPublish(
      guidedModel({ findings: [{ ...baseFinding, value: { ...baseFinding.value, body } }] }),
      terminal,
    );

    expect(terminal.frames.at(-2)).toContain('body-line-20');
    expect(terminal.frames.at(-2)).not.toContain('body-line-10');
    expect(terminal.frames.at(-1)).toContain('body-line-10');
    expect(terminal.frames.at(-1)).not.toContain('body-line-20');
  });

  it('offers only refresh or cancel for a stale review bundle', async () => {
    const terminal = new FakeTerminal(['enter']);

    const choice = await runStalePublishPrompt(terminal);

    expect(choice).toBe('refresh');
    expect(terminal.frames[0]).toContain(
      'This review bundle is stale and its previews may no longer match the target.',
    );
    expect(terminal.frames[0]).toContain('> Refresh bundle');
    expect(terminal.frames[0]).toContain('  Cancel');
    expect(terminal.frames[0]).not.toContain('Review material');
    expect(terminal.frames[0].split('\n').filter((line) => line.length > 0)).toHaveLength(3);
    expect(terminal.stops).toBe(1);
  });

  it('lets a stale-bundle prompt be cancelled', async () => {
    const terminal = new FakeTerminal(['down', 'enter']);

    await expect(runStalePublishPrompt(terminal)).resolves.toBe('cancel');
    expect(terminal.frames.at(-1)).toContain('> Cancel');
  });

  it.each(['escape', 'interrupt'] as const)('cancels the stale-bundle prompt on %s', async (key) => {
    const terminal = new FakeTerminal([key]);

    await expect(runStalePublishPrompt(terminal)).resolves.toBe('cancel');
    expect(terminal.stops).toBe(1);
  });

  it('decodes Node keypresses and restores raw terminal state', async () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      resume: vi.fn(),
      pause: vi.fn(),
      isPaused: vi.fn(() => true),
      setRawMode: vi.fn((raw: boolean) => {
        input.isRaw = raw;
        return input;
      }),
    });
    const output = {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: vi.fn(() => true),
    };
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    expect(terminal.interactive).toBe(true);
    await terminal.start();
    const key = terminal.readKey();
    input.emit('keypress', 'c', { name: 'c', ctrl: true });
    await expect(key).resolves.toBe('interrupt');
    terminal.writeFrame('frame body');
    await terminal.stop();

    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenCalledWith('\u001b[?25l');
    expect(output.write).toHaveBeenCalledWith('\u001b[2J\u001b[Hframe body');
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?25h\u001b[2J\u001b[H');
  });

  it.each([
    ['up', undefined, { name: 'up' }, 'up'],
    ['down', undefined, { name: 'down' }, 'down'],
    ['page up', undefined, { name: 'pageup' }, 'page-up'],
    ['page down', undefined, { name: 'pagedown' }, 'page-down'],
    ['return', undefined, { name: 'return' }, 'enter'],
    ['enter alias', undefined, { name: 'enter' }, 'enter'],
    ['escape', undefined, { name: 'escape' }, 'escape'],
    ['named space', undefined, { name: 'space' }, 'space'],
    ['literal space', ' ', undefined, 'space'],
    ['group shortcut', 'a', undefined, 'toggle-group'],
    ['plain c', 'c', { name: 'c' }, 'other'],
    ['another control key', 'x', { name: 'x', ctrl: true }, 'other'],
  ] as const)('decodes the Node %s keypress', async (_label, value, details, expected) => {
    const input = Object.assign(new EventEmitter(), { isTTY: true });
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: { isTTY: true } as NodeJS.WriteStream,
    });

    const key = terminal.readKey();
    input.emit('keypress', value, details);

    await expect(key).resolves.toBe(expected);
  });

  it.each([
    [false, true],
    [true, false],
  ])('is non-interactive unless both input and output are TTYs', (inputIsTty, outputIsTty) => {
    const terminal = createNodePublishTerminal({
      input: { isTTY: inputIsTty } as NodeJS.ReadStream,
      output: { isTTY: outputIsTty } as NodeJS.WriteStream,
    });

    expect(terminal.interactive).toBe(false);
  });

  it('pauses a fresh stdin stream after restoring terminal mode', async () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      readableFlowing: null as boolean | null,
      resume: vi.fn(),
      pause: vi.fn(),
      isPaused: vi.fn(() => false),
      setRawMode: vi.fn(),
    });
    const output = {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: vi.fn(() => true),
    };
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    await terminal.start();
    await terminal.stop();

    expect(input.pause).toHaveBeenCalledOnce();
  });

  it('leaves a previously flowing stdin stream flowing after cleanup', async () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      readableFlowing: true,
      resume: vi.fn(),
      pause: vi.fn(),
      setRawMode: vi.fn(),
    });
    const output = {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: vi.fn(() => true),
    };
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    await terminal.start();
    await terminal.stop();

    expect(input.pause).not.toHaveBeenCalled();
  });

  it('restores raw mode, input flow, and cursor visibility when terminal startup fails', () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      readableFlowing: null as boolean | null,
      resume: vi.fn(),
      pause: vi.fn(),
      setRawMode: vi.fn(),
    });
    const output = {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: vi.fn((value: string) => {
        if (value === '\u001b[?25l') throw new Error('hide cursor failed');
        return true;
      }),
    };
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    expect(() => terminal.start()).toThrow('hide cursor failed');

    expect(input.setRawMode).toHaveBeenNthCalledWith(1, true);
    expect(input.setRawMode).toHaveBeenNthCalledWith(2, false);
    expect(input.pause).toHaveBeenCalledOnce();
    expect(output.write).toHaveBeenLastCalledWith('\u001b[?25h');
  });

  it('does not pause an already-flowing input when terminal startup fails', () => {
    const input = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      readableFlowing: true,
      resume: vi.fn(),
      pause: vi.fn(),
      setRawMode: vi.fn(),
    });
    const output = {
      isTTY: true,
      columns: 100,
      rows: 24,
      write: vi.fn((value: string) => {
        if (value === '\u001b[?25l') throw new Error('hide cursor failed');
        return true;
      }),
    };
    const terminal = createNodePublishTerminal({
      input: input as unknown as NodeJS.ReadStream,
      output: output as unknown as NodeJS.WriteStream,
    });

    expect(() => terminal.start()).toThrow('hide cursor failed');
    expect(input.pause).not.toHaveBeenCalled();
  });

  it('rejects non-interactive use with explicit-command guidance before starting', async () => {
    const terminal = new FakeTerminal([]);
    terminal.interactive = false;

    await expect(runGuidedPublish(guidedModel(), terminal)).rejects.toThrow(
      'Interactive publishing requires a terminal.\n' +
        'Use `revpack publish all` or a specific `revpack publish <command>` in scripts.',
    );
    expect(terminal.starts).toBe(0);
    expect(terminal.frames).toEqual([]);
  });

  it('restores terminal state when a key read fails', async () => {
    const terminal = new FakeTerminal([]);

    await expect(runGuidedPublish(guidedModel(), terminal)).rejects.toThrow('Fake terminal ran out of keys.');
    expect(terminal.stops).toBe(1);
  });

  it('returns from confirmation to selection with Escape', async () => {
    const terminal = new FakeTerminal(['enter', 'escape', 'space', 'enter', 'enter']);

    const selection = await runGuidedPublish(guidedModel(), terminal);

    expect(selection?.findingIndexes).toEqual([9]);
    expect(terminal.frames.filter((frame) => frame.startsWith('Publish:'))).toHaveLength(2);
  });

  it('cancels immediately on Ctrl+C key events', async () => {
    const terminal = new FakeTerminal(['enter', 'interrupt']);

    await expect(runGuidedPublish(guidedModel(), terminal)).resolves.toBeNull();
    expect(terminal.stops).toBe(1);
  });
});
