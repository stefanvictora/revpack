import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';

interface SetupFile {
  /** Path relative to the target project root. */
  target: string;
  /** Source: either a path relative to the templates/ dir, or inline content. */
  source?: string;
  inline?: string;
  /** Description shown in the output. */
  label: string;
}

const REVIEW_CONFIG_FILES: SetupFile[] = [
  {
    target: 'REVIEW.md',
    source: 'REVIEW.md',
    label: 'Review guidelines',
  },
];

const PROMPT_FILES: SetupFile[] = [
  {
    target: path.join('.github', 'prompts', 'review.prompt.md'),
    source: path.join('prompts', 'review.prompt.md'),
    label: 'Copilot prompt: full code review (threads + new issues + fixes)',
  },
  {
    target: path.join('.github', 'prompts', 'review-summarize.prompt.md'),
    source: path.join('prompts', 'review-summarize.prompt.md'),
    label: 'Copilot prompt: generate MR summary',
  },
];

export function registerSetupCommand(program: Command): void {
  program
    .command('setup')
    .description('Optional one-time project setup — creates REVIEW.md and optionally Copilot prompts')
    .option('--prompts', 'Also install Copilot Chat prompt files (.github/prompts/)')
    .option('--dry-run', 'Show what would be created without writing files')
    .action(async (opts: { prompts?: boolean; dryRun?: boolean }) => {
      await runSetup({ cwd: process.cwd(), prompts: opts.prompts, dryRun: opts.dryRun });
    });
}

export async function runSetup(opts: { cwd: string; prompts?: boolean; dryRun?: boolean }): Promise<void> {
  const files = [...REVIEW_CONFIG_FILES];
  if (opts.prompts) {
    files.push(...PROMPT_FILES);
  }

  const templatesDir = resolveTemplatesDir();
  const created: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const targetPath = path.join(opts.cwd, file.target);
    const exists = await fileExists(targetPath);

    if (exists) {
      skipped.push(file.target);
      continue;
    }

    if (opts.dryRun) {
      created.push(file.target);
      continue;
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true });

    if (file.inline) {
      await fs.writeFile(targetPath, file.inline, 'utf-8');
    } else if (file.source) {
      const sourcePath = path.join(templatesDir, file.source);
      const content = await fs.readFile(sourcePath, 'utf-8');
      await fs.writeFile(targetPath, content, 'utf-8');
    }

    created.push(file.target);
  }

  // Output summary
  if (opts.dryRun) {
    console.log(chalk.dim('Dry run — no files written.\n'));
  }

  if (created.length > 0) {
    console.log(chalk.green(`${opts.dryRun ? 'Would create' : 'Created'}:`));
    for (const f of created) {
      const label = files.find((x) => x.target === f)?.label ?? '';
      console.log(`  ${chalk.green('+')} ${f}  ${chalk.dim(label)}`);
    }
  }

  if (skipped.length > 0) {
    if (created.length > 0) console.log('');
    console.log(chalk.dim('Skipped (already exist):'));
    for (const f of skipped) {
      console.log(`  ${chalk.dim('·')} ${f}`);
    }
  }

  if (created.length === 0 && skipped.length > 0) {
    console.log('');
    console.log(chalk.dim('Nothing to do — project already set up.'));
  }

  if (!opts.dryRun && created.length > 0) {
    console.log('');
    console.log(chalk.dim('Next steps:'));
    if (created.includes('REVIEW.md')) {
      console.log(chalk.dim('  1. Edit REVIEW.md — tailor review priorities to your project'));
    }
    if (!opts.prompts) {
      console.log(chalk.dim('  Tip: run with --prompts to also install Copilot Chat prompt files'));
    }
    console.log(chalk.dim('  Then run `revpack prepare` to prepare a review bundle.'));
  }
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
