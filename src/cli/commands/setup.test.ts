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

    await expect(fileExists(path.join('.cursor', 'commands', 'revpack-review.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.cursor', 'rules', 'revpack-review.mdc'))).resolves.toBe(false);
    await expect(fileExists(path.join('.cursor', 'rules', 'revpack.mdc'))).resolves.toBe(false);

    const content = await fs.readFile(path.join(cwd, '.cursor', 'commands', 'revpack-review.md'), 'utf-8');
    expect(content).toContain('# Revpack Review');
    expect(content).toContain('## Locate the bundle');
    expect(content).not.toContain('{{revpack-review-instructions}}');
  });

  it('installs the Codex skill at the canonical revpack-review path', async () => {
    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists('AGENTS.md')).resolves.toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Use it in Codex with:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('  $revpack-review'));

    const content = await fs.readFile(path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('# Revpack Review');
    expect(content).toContain('## Locate the bundle');
    expect(content).not.toContain('{{revpack-review-instructions}}');
  });

  it('does not rewrite an already existing Codex skill', async () => {
    await runSetupAgent({ cwd, target: 'codex' });
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    const first = await fs.readFile(skillPath, 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toBe(first);
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
