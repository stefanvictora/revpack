import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSetupCommand, runSetup, runSetupAgent } from './setup.js';

describe('runSetup', () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'revpack-setup-'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
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
    await expect(fileExists(path.join('.github', 'prompts', 'revpack-context.prompt.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.github', 'prompts', 'review.prompt.md'))).resolves.toBe(false);
    await expect(fileExists(path.join('.github', 'prompts', 'review-summarize.prompt.md'))).resolves.toBe(false);
  });

  it('installs both selected agent adapters without REVIEW.md', async () => {
    await runSetupAgent({ cwd, target: 'claude' });

    await expect(fileExists('REVIEW.md')).resolves.toBe(false);
    await expect(fileExists(path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.claude', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(true);
  });

  it('installs REVIEW.md and both selected adapters with setup --agent', async () => {
    await runSetup({ cwd, agent: 'codex' });

    await expect(fileExists('REVIEW.md')).resolves.toBe(true);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Use the revpack adapters in Codex with:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('  $revpack-review'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('  $revpack-context'));
    expect(countLogLinesContaining('revpack prepare')).toBe(1);
  });

  it('installs the Cursor adapters at their canonical paths', async () => {
    await runSetupAgent({ cwd, target: 'cursor' });

    await expect(fileExists(path.join('.cursor', 'commands', 'revpack-review.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.cursor', 'commands', 'revpack-context.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.cursor', 'rules', 'revpack-review.mdc'))).resolves.toBe(false);
    await expect(fileExists(path.join('.cursor', 'rules', 'revpack.mdc'))).resolves.toBe(false);

    const content = await fs.readFile(path.join(cwd, '.cursor', 'commands', 'revpack-review.md'), 'utf-8');
    expect(content).toContain('# Revpack Review');
    expect(content).toContain('## Locate the bundle');
    expect(content).not.toContain('{{revpack-review-instructions}}');

    const contextContent = await fs.readFile(path.join(cwd, '.cursor', 'commands', 'revpack-context.md'), 'utf-8');
    expect(contextContent).toContain('# Revpack Context');
    expect(contextContent).toContain('## Use the context');
    expect(contextContent).not.toContain('{{revpack-context-instructions}}');
  });

  it('installs the Codex skills at their canonical paths', async () => {
    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists('AGENTS.md')).resolves.toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Use the revpack adapters in Codex with:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('  $revpack-review'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('  $revpack-context'));

    const content = await fs.readFile(path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md'), 'utf-8');
    expect(content).toContain('# Revpack Review');
    expect(content).toContain('## Locate the bundle');
    expect(content).not.toContain('{{revpack-review-instructions}}');
    expect(content).toContain('<!-- revpack-managed: sha256:');

    const contextContent = await fs.readFile(
      path.join(cwd, '.agents', 'skills', 'revpack-context', 'SKILL.md'),
      'utf-8',
    );
    expect(contextContent).toContain('# Revpack Context');
    expect(contextContent).toContain('without performing a formal code review');
    expect(contextContent).toContain('fix or address active review threads');
    expect(contextContent).toContain('treat it as authoritative');
    expect(contextContent).toContain('Do not fall back to candidate discovery');
    expect(contextContent).not.toContain('Write only under');
    expect(contextContent).not.toContain('{{revpack-context-instructions}}');
    expect(contextContent).toContain('<!-- revpack-managed: sha256:');
  });

  it('leaves already current managed skills unchanged', async () => {
    await runSetupAgent({ cwd, target: 'codex' });
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    const first = await fs.readFile(skillPath, 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toBe(first);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipped (already current):'));
  });

  it('adopts an unmarked current adapter and adds managed provenance', async () => {
    await runSetupAgent({ cwd, target: 'codex' });
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    const generated = await fs.readFile(skillPath, 'utf-8');
    const unmarked = generated.replace(/\n<!-- revpack-managed: sha256:[a-f0-9]{64} -->\n?$/, '');
    await fs.writeFile(skillPath, unmarked, 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toContain('<!-- revpack-managed: sha256:');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated:'));
  });

  it('updates an unchanged older managed adapter', async () => {
    await runSetupAgent({ cwd, target: 'codex' });
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    const oldBody = '# Older generated adapter\n';
    await fs.writeFile(skillPath, withManagedMarker(oldBody), 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    const updated = await fs.readFile(skillPath, 'utf-8');
    expect(updated).toContain('# Revpack Review');
    expect(updated).not.toContain('# Older generated adapter');
  });

  it('recognizes and updates an unmarked adapter generated by v0.4.0', async () => {
    const commandPath = path.join(cwd, '.cursor', 'commands', 'revpack-review.md');
    const legacyFixture = await fs.readFile(
      fileURLToPath(new URL('__fixtures__/revpack-review-v0.4.0-cursor.md', import.meta.url)),
      'utf-8',
    );
    await fs.mkdir(path.dirname(commandPath), { recursive: true });
    await fs.writeFile(commandPath, legacyFixture, 'utf-8');

    await runSetupAgent({ cwd, target: 'cursor' });

    const updated = await fs.readFile(commandPath, 'utf-8');
    expect(updated).toContain('follow its formal revpack review route');
    expect(updated).toContain('<!-- revpack-managed: sha256:');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Updated:'));
  });

  it('preserves customized adapters and prints a force hint', async () => {
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '# My custom review workflow\n', 'utf-8');

    await runSetupAgent({ cwd, target: 'codex' });

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toBe('# My custom review workflow\n');
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Skipped (customized):'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('revpack setup agent codex --force'));
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(true);
  });

  it('prints refresh hints only for the target with customized adapters', async () => {
    const promptPath = path.join(cwd, '.github', 'prompts', 'revpack-review.prompt.md');
    await fs.mkdir(path.dirname(promptPath), { recursive: true });
    await fs.writeFile(promptPath, '# My custom Copilot workflow\n', 'utf-8');

    await runSetup({ cwd, agent: 'codex', prompts: true });

    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('revpack setup agent codex --force'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('revpack setup agent copilot --force'));
  });

  it('replaces customized adapters with --force without replacing REVIEW.md', async () => {
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '# My custom review workflow\n', 'utf-8');
    await fs.writeFile(path.join(cwd, 'REVIEW.md'), '# Project review guidance\n', 'utf-8');

    await runSetup({ cwd, agent: 'codex', force: true });

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toContain('# Revpack Review');
    await expect(fs.readFile(path.join(cwd, 'REVIEW.md'), 'utf-8')).resolves.toBe('# Project review guidance\n');
  });

  it('does not write files during dry runs', async () => {
    await runSetupAgent({ cwd, target: 'claude', dryRun: true });

    await expect(fileExists(path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(false);
    await expect(fileExists(path.join('.claude', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(false);
  });

  it('does not print combined adapter usage during dry runs', async () => {
    await runSetup({ cwd, agent: 'codex', dryRun: true });

    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(false);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(false);
    expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('Use the revpack adapters in Codex with:'));
    expect(countLogLinesContaining('revpack prepare')).toBe(0);
  });

  it('honors --dry-run on the parsed setup agent command', async () => {
    process.chdir(cwd);
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await program.parseAsync(['node', 'revpack', 'setup', 'agent', 'codex', '--dry-run']);

    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Would create:'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Dry run - no files written.'));
  });

  it('parses setup --agent as combined review guidance and adapter setup', async () => {
    process.chdir(cwd);
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await program.parseAsync(['node', 'revpack', 'setup', '--agent', 'codex']);

    await expect(fileExists('REVIEW.md')).resolves.toBe(true);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'))).resolves.toBe(true);
    await expect(fileExists(path.join('.agents', 'skills', 'revpack-context', 'SKILL.md'))).resolves.toBe(true);
  });

  it('parses --force on the setup agent command', async () => {
    const skillPath = path.join(cwd, '.agents', 'skills', 'revpack-review', 'SKILL.md');
    await fs.mkdir(path.dirname(skillPath), { recursive: true });
    await fs.writeFile(skillPath, '# My custom review workflow\n', 'utf-8');
    process.chdir(cwd);
    const program = new Command();
    program.exitOverride();
    registerSetupCommand(program);

    await program.parseAsync(['node', 'revpack', 'setup', 'agent', 'codex', '--force']);

    await expect(fs.readFile(skillPath, 'utf-8')).resolves.toContain('# Revpack Review');
  });

  async function fileExists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(path.join(cwd, relativePath));
      return true;
    } catch {
      return false;
    }
  }

  function countLogLinesContaining(value: string): number {
    return vi.mocked(console.log).mock.calls.filter(([line]) => String(line).includes(value)).length;
  }

  function withManagedMarker(body: string): string {
    const normalized = `${body.replace(/\r\n?/g, '\n').trimEnd()}\n`;
    const hash = createHash('sha256').update(normalized, 'utf-8').digest('hex');
    return `${normalized}\n<!-- revpack-managed: sha256:${hash} -->\n`;
  }
});
