import { InvalidArgumentError, type Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

interface SetupFile {
  /** Path relative to the target project root. */
  target: string;
  /** Source path relative to the templates/ dir. */
  source: string;
  /** Description shown in the output. */
  label: string;
}

type AgentTarget = 'claude' | 'codex' | 'copilot' | 'cursor';
type SetupStatus = 'created' | 'updated' | 'skipped-exists' | 'skipped-current';

interface SetupResult {
  target: string;
  label: string;
  status: SetupStatus;
}

interface SetupOptions {
  cwd: string;
  prompts?: boolean;
  dryRun?: boolean;
}

interface SetupAgentOptions {
  cwd: string;
  target: AgentTarget;
  dryRun?: boolean;
}

const SUPPORTED_AGENT_TARGETS: AgentTarget[] = ['claude', 'codex', 'copilot', 'cursor'];
const REVIEW_INCLUDE = '{{revpack-review-instructions}}';
const CODEX_BEGIN_MARKER = '<!-- revpack:begin -->';
const CODEX_END_MARKER = '<!-- revpack:end -->';

const REVIEW_CONFIG_FILE: SetupFile = {
  target: 'REVIEW.md',
  source: 'REVIEW.md',
  label: 'Review guidelines',
};

const AGENT_FILES: Record<Exclude<AgentTarget, 'codex'>, SetupFile> = {
  claude: {
    target: path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'),
    source: path.join('claude', 'skills', 'revpack-review', 'SKILL.md'),
    label: 'Claude skill: revpack-review',
  },
  copilot: {
    target: path.join('.github', 'prompts', 'revpack-review.prompt.md'),
    source: path.join('copilot', 'revpack-review.prompt.md'),
    label: 'Copilot prompt: revpack-review',
  },
  cursor: {
    target: path.join('.cursor', 'rules', 'revpack-review.mdc'),
    source: path.join('cursor', 'rules', 'revpack-review.mdc'),
    label: 'Cursor rule: revpack-review',
  },
};

const CODEX_FILE: SetupFile = {
  target: 'AGENTS.md',
  source: path.join('codex', 'agents-block.md'),
  label: 'Codex instructions: revpack block',
};

export function registerSetupCommand(program: Command): void {
  const setupCmd = program
    .command('setup')
    .description('Create REVIEW.md and optional agent harness files')
    .option('--prompts', 'Deprecated alias for `setup agent copilot`')
    .option('--dry-run', 'Show what would be created or updated without writing files')
    .action(async (opts: { prompts?: boolean; dryRun?: boolean }) => {
      await runSetup({ cwd: process.cwd(), prompts: opts.prompts, dryRun: opts.dryRun });
    });

  setupCmd
    .command('agent')
    .description('Install an agent harness adapter')
    .argument('<target>', `Agent harness target (${SUPPORTED_AGENT_TARGETS.join(', ')})`, parseAgentTarget)
    .option('--dry-run', 'Show what would be created or updated without writing files')
    .action(async (target: AgentTarget, opts: { dryRun?: boolean }) => {
      await runSetupAgent({ cwd: process.cwd(), target, dryRun: opts.dryRun });
    });
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const files = opts.prompts ? [REVIEW_CONFIG_FILE, AGENT_FILES.copilot] : [REVIEW_CONFIG_FILE];
  const results = await installCopiedFiles(opts.cwd, templatesDir, files, opts.dryRun);

  printResults(results, opts.dryRun);

  if (!opts.dryRun && results.some((result) => result.status === 'created' || result.status === 'updated')) {
    console.log('');
    console.log(chalk.dim('Next steps:'));
    if (results.some((result) => result.target === 'REVIEW.md' && result.status === 'created')) {
      console.log(chalk.dim('  1. Edit REVIEW.md - tailor review priorities to your project'));
    }
    if (!opts.prompts) {
      console.log(
        chalk.dim(
          '  Tip: install an agent adapter with `revpack setup agent codex`, `claude`, `copilot`, or `cursor`.',
        ),
      );
    } else {
      console.log(chalk.dim('  Tip: `revpack setup --prompts` is deprecated; use `revpack setup agent copilot`.'));
    }
    console.log(chalk.dim('  Then run `revpack prepare` to prepare a review bundle.'));
  }
}

export async function runSetupAgent(opts: SetupAgentOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const results =
    opts.target === 'codex'
      ? [await installCodexBlock(opts.cwd, templatesDir, opts.dryRun)]
      : await installCopiedFiles(opts.cwd, templatesDir, [AGENT_FILES[opts.target]], opts.dryRun);

  printResults(results, opts.dryRun);
  printAgentUsage(opts.target);

  if (!(await fileExists(path.join(opts.cwd, 'REVIEW.md')))) {
    console.log(chalk.dim('Tip: run `revpack setup` to add project-specific review guidance in REVIEW.md.'));
  }
}

async function installCopiedFiles(
  cwd: string,
  templatesDir: string,
  files: SetupFile[],
  dryRun = false,
): Promise<SetupResult[]> {
  const results: SetupResult[] = [];

  for (const file of files) {
    const targetPath = path.join(cwd, file.target);
    if (await fileExists(targetPath)) {
      results.push({ target: file.target, label: file.label, status: 'skipped-exists' });
      continue;
    }

    if (!dryRun) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, await renderTemplate(templatesDir, file.source), 'utf-8');
    }

    results.push({ target: file.target, label: file.label, status: 'created' });
  }

  return results;
}

async function installCodexBlock(cwd: string, templatesDir: string, dryRun = false): Promise<SetupResult> {
  const targetPath = path.join(cwd, CODEX_FILE.target);
  const block = ensureTrailingNewline(normalizeLineEndings(await readTemplate(templatesDir, CODEX_FILE.source)).trim());

  if (!(await fileExists(targetPath))) {
    if (!dryRun) {
      await fs.writeFile(targetPath, block, 'utf-8');
    }
    return { target: CODEX_FILE.target, label: CODEX_FILE.label, status: 'created' };
  }

  const content = normalizeLineEndings(await fs.readFile(targetPath, 'utf-8'));
  const begin = content.indexOf(CODEX_BEGIN_MARKER);
  const end = content.indexOf(CODEX_END_MARKER, begin === -1 ? 0 : begin + CODEX_BEGIN_MARKER.length);

  if (begin === -1 && end === -1) {
    const nextContent = ensureTrailingNewline(`${content.trimEnd()}\n\n${block.trimEnd()}`);
    if (!dryRun) {
      await fs.writeFile(targetPath, nextContent, 'utf-8');
    }
    return { target: CODEX_FILE.target, label: CODEX_FILE.label, status: 'updated' };
  }

  if (begin === -1 || end === -1 || end < begin) {
    throw new Error('AGENTS.md contains a partial revpack block.');
  }

  const blockEnd = end + CODEX_END_MARKER.length;
  const currentBlock = content.slice(begin, blockEnd);
  if (normalizeLineEndings(currentBlock).trim() === block.trim()) {
    return { target: CODEX_FILE.target, label: CODEX_FILE.label, status: 'skipped-current' };
  }

  const nextContent = ensureTrailingNewline(`${content.slice(0, begin)}${block.trimEnd()}${content.slice(blockEnd)}`);
  if (!dryRun) {
    await fs.writeFile(targetPath, nextContent, 'utf-8');
  }
  return { target: CODEX_FILE.target, label: CODEX_FILE.label, status: 'updated' };
}

async function renderTemplate(templatesDir: string, source: string): Promise<string> {
  const content = await readTemplate(templatesDir, source);
  const includeCount = content.split(REVIEW_INCLUDE).length - 1;

  if (includeCount === 0) {
    return normalizeLineEndings(content);
  }

  if (includeCount !== 1) {
    throw new Error(`${source} must contain exactly one ${REVIEW_INCLUDE} marker.`);
  }

  const instructions = normalizeLineEndings(
    await readTemplate(templatesDir, path.join('agent', 'revpack-review-instructions.md')),
  ).trim();
  return normalizeLineEndings(content).replace(REVIEW_INCLUDE, instructions);
}

async function readTemplate(templatesDir: string, source: string): Promise<string> {
  return fs.readFile(path.join(templatesDir, source), 'utf-8');
}

function printResults(results: SetupResult[], dryRun = false): void {
  const groups: Array<{ status: SetupStatus; title: string; marker: string }> = [
    { status: 'created', title: dryRun ? 'Would create' : 'Created', marker: '+' },
    { status: 'updated', title: dryRun ? 'Would update' : 'Updated', marker: '~' },
    { status: 'skipped-exists', title: 'Skipped (already exist)', marker: '.' },
    { status: 'skipped-current', title: 'Skipped (already current)', marker: '.' },
  ];

  let printed = false;
  for (const group of groups) {
    const matching = results.filter((result) => result.status === group.status);
    if (matching.length === 0) continue;

    if (printed) console.log('');
    console.log(
      group.status === 'created' || group.status === 'updated'
        ? chalk.green(`${group.title}:`)
        : chalk.dim(`${group.title}:`),
    );
    for (const result of matching) {
      const color = group.status === 'created' || group.status === 'updated' ? chalk.green : chalk.dim;
      console.log(`  ${color(group.marker)} ${result.target}  ${chalk.dim(result.label)}`);
    }
    printed = true;
  }

  if (dryRun && results.length > 0) {
    console.log('');
    console.log(chalk.dim('Dry run - no files written.'));
  }
}

function printAgentUsage(target: AgentTarget): void {
  console.log('');
  switch (target) {
    case 'claude':
      console.log(chalk.dim('Use it in Claude Code with /revpack-review.'));
      break;
    case 'codex':
      console.log(chalk.dim('Codex will read AGENTS.md automatically in this repository.'));
      break;
    case 'copilot':
      console.log(chalk.dim('Use it in Copilot Chat with /revpack-review.'));
      break;
    case 'cursor':
      console.log(chalk.dim('Use it in Cursor by asking for a revpack review.'));
      break;
  }
}

function parseAgentTarget(value: string): AgentTarget {
  if (SUPPORTED_AGENT_TARGETS.includes(value as AgentTarget)) {
    return value as AgentTarget;
  }
  throw new InvalidArgumentError(
    `Unsupported agent target: ${value}. Supported targets: ${SUPPORTED_AGENT_TARGETS.join(', ')}`,
  );
}

function normalizeLineEndings(content: string): string {
  return content.replace(/\r\n?/g, '\n');
}

function ensureTrailingNewline(content: string): string {
  return `${content.replace(/\s+$/u, '')}\n`;
}

function resolveTemplatesDir(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/cli/commands/setup.js -> package root -> templates/
  return path.resolve(path.dirname(thisFile), '..', '..', '..', 'templates');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
