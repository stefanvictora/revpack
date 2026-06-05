import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runSetup, runSetupAgent } from './setup.js';

describe('runSetup', () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-setup-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(cwd, { recursive: true, force: true });
  });

  it('installs only REVIEW.md by default', async () => {
    await runSetup({ cwd });

    await expect(fileExists('REVIEW.md')).resolves.toBe(true);
    await expect(fileExists(path.join('.github', 'prompts', 'revpack-review.prompt.md'))).resolves.toBe(false);
  });

  it('keeps --prompts as a backward-compatible Copilot alias', async () => {
    await runSetup({ cwd, prompts: true });

    await expect(fileExists('REVIEW.md')).resolves.toBe(true);
    await expect(fileExists(path.join('.github', 'prompts', 'revpack-review.prompt.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.github', 'prompts', 'review.prompt.md'))).resolves.toBe(false);
    await expect(fileExists(path.join('.github', 'prompts', 'review-summarize.prompt.md'))).resolves.toBe(false);
  });

  it('installs one selected copied agent adapter without REVIEW.md', async () => {
    await runSetupAgent({ cwd, target: 'claude' });

    await expect(fileExists('REVIEW.md')).resolves.toBe(false);
    await expect(fileExists(path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
  });

  it('installs the Cursor adapter at the canonical revpack-review path', async () => {
    await runSetupAgent({ cwd, target: 'cursor' });

    await expect(fileExists(path.join('.cursor', 'rules', 'revpack-review.mdc'))).resolves.toBe(true);
    await expect(fileExists(path.join('.cursor', 'rules', 'revpack.mdc'))).resolves.toBe(false);
  });

  it('creates AGENTS.md with the managed Codex block', async () => {
    await runSetupAgent({ cwd, target: 'codex' });

    const content = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('<!-- revpack:begin -->');
    expect(content).toContain('## Revpack review bundles');
    expect(content).toContain('<!-- revpack:end -->');
  });

  it('appends the managed Codex block to an existing AGENTS.md', async () => {
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), '# Team instructions\n\nKeep this line.\n', 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    const content = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content.startsWith('# Team instructions\n\nKeep this line.\n\n<!-- revpack:begin -->')).toBe(true);
  });

  it('updates an existing managed Codex block', async () => {
    await fs.writeFile(
      path.join(cwd, 'AGENTS.md'),
      '# Team instructions\n\n<!-- revpack:begin -->\nold\n<!-- revpack:end -->\n',
      'utf-8',
    );

    await runSetupAgent({ cwd, target: 'codex' });

    const content = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('# Team instructions');
    expect(content).toContain('## Revpack review bundles');
    expect(content).not.toContain('\nold\n');
  });

  it('does not rewrite an already current Codex block', async () => {
    await runSetupAgent({ cwd, target: 'codex' });
    const first = await fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fs.readFile(path.join(cwd, 'AGENTS.md'), 'utf-8')).resolves.toBe(first);
  });

  it('does not write files during dry runs', async () => {
    await runSetupAgent({ cwd, target: 'claude', dryRun: true });

    await expect(fileExists(path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(false);
  });

  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(cwd, relativePath));
      return true;
    } catch {
      return false;
    }
  }
});
