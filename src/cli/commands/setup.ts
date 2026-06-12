import { InvalidArgumentError, type Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import { formatGuidanceLine } from '../output.js';

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

const REVIEW_CONFIG_FILE: SetupFile = {
  target: 'REVIEW.md',
  source: 'REVIEW.md',
  label: 'Review guidelines',
};

const AGENT_FILES: Record<AgentTarget, SetupFile> = {
  claude: {
    target: path.join('.claude', 'skills', 'revpack-review', 'SKILL.md'),
    source: path.join('claude', 'skills', 'revpack-review', 'SKILL.md'),
    label: 'Claude skill: revpack-review',
  },
  codex: {
    target: path.join('.agents', 'skills', 'revpack-review', 'SKILL.md'),
    source: path.join('codex', 'skills', 'revpack-review', 'SKILL.md'),
    label: 'Codex skill: revpack-review',
  },
  copilot: {
    target: path.join('.github', 'prompts', 'revpack-review.prompt.md'),
    source: path.join('copilot', 'revpack-review.prompt.md'),
    label: 'Copilot prompt: revpack-review',
  },
  cursor: {
    target: path.join('.cursor', 'commands', 'revpack-review.md'),
    source: path.join('cursor', 'commands', 'revpack-review.md'),
    label: 'Cursor command: revpack-review',
  },
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
    .action(async (target: AgentTarget, _opts: { dryRun?: boolean }, cmd: Command) => {
      await runSetupAgent({ cwd: process.cwd(), target, dryRun: cmd.optsWithGlobals<{ dryRun?: boolean }>().dryRun });
    });
}

export async function runSetup(opts: SetupOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const files = opts.prompts ? [REVIEW_CONFIG_FILE, AGENT_FILES.copilot] : [REVIEW_CONFIG_FILE];
  const results = await installCopiedFiles(opts.cwd, templatesDir, files, opts.dryRun);

  printResults(results, opts.dryRun);

  if (!opts.dryRun && results.some((result) => result.status === 'created' || result.status === 'updated')) {
    console.log('');
    console.log(formatGuidanceLine('Next steps:'));
    if (results.some((result) => result.target === 'REVIEW.md' && result.status === 'created')) {
      console.log(formatGuidanceLine('  1. Edit REVIEW.md - tailor review priorities to your project'));
    }
    if (!opts.prompts) {
      console.log(formatGuidanceLine('  Tip: install an agent adapter, for example:'));
      console.log(formatGuidanceLine('  `revpack setup agent codex`'));
    } else {
      console.log(formatGuidanceLine('  Tip: `revpack setup --prompts` is deprecated; use:'));
      console.log(formatGuidanceLine('  `revpack setup agent copilot`'));
    }
    console.log(formatGuidanceLine('  `revpack prepare`'));
  }
}

export async function runSetupAgent(opts: SetupAgentOptions): Promise<void> {
  const templatesDir = resolveTemplatesDir();
  const results = await installCopiedFiles(opts.cwd, templatesDir, [AGENT_FILES[opts.target]], opts.dryRun);

  printResults(results, opts.dryRun);
  printAgentUsage(opts.target);

  if (!(await fileExists(path.join(opts.cwd, 'REVIEW.md')))) {
    console.log(formatGuidanceLine('Tip: add project-specific review guidance in REVIEW.md.'));
    console.log(formatGuidanceLine('  `revpack setup`'));
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
      console.log(formatGuidanceLine('Use it in Claude Code with:'));
      console.log(formatGuidanceLine('  `/revpack-review`'));
      break;
    case 'codex':
      console.log(formatGuidanceLine('Use it in Codex with:'));
      console.log(formatGuidanceLine('  `$revpack-review`'));
      break;
    case 'copilot':
      console.log(formatGuidanceLine('Use it in Copilot Chat with:'));
      console.log(formatGuidanceLine('  `/revpack-review`'));
      break;
    case 'cursor':
      console.log(formatGuidanceLine('Use it in Cursor by asking for a revpack review.'));
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
