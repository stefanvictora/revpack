import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import type { NewFinding } from '../../core/types.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

const DEFAULT_FINDINGS_FILE = '.review-assist/outputs/new-findings.json';

interface FindingEntry extends NewFinding {
  published?: boolean;
}

async function loadNewFindings(filePath: string): Promise<FindingEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read ${filePath}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as FindingEntry[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of { filePath, line, body, severity, category } objects`);
  }
}

async function saveFindings(filePath: string, entries: FindingEntry[]): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

export function registerPublishFindingCommand(program: Command): void {
  program
    .command('publish-finding')
    .description([
      'Publish agent-generated findings as new discussion threads.',
      '  Reads from outputs/new-findings.json by default.',
    ].join('\n'))
    .option('--from <file>', `Findings JSON file (default: ${DEFAULT_FINDINGS_FILE})`)
    .option('--dry-run', 'Show what would be published without creating threads')
    .option('--force', 'Re-publish already-published findings')
    .action(async (opts: { from?: string; dryRun?: boolean; force?: boolean }) => {
      try {
        const filePath = opts.from ?? DEFAULT_FINDINGS_FILE;
        const findings = await loadNewFindings(filePath);

        if (findings.length === 0) {
          console.log(chalk.dim('No new findings to publish.'));
          return;
        }

        const pending = opts.force ? findings : findings.filter((f) => !f.published);

        if (opts.dryRun) {
          console.log(chalk.bold(`${pending.length} finding(s) would be published:\n`));
          for (const f of pending) {
            console.log(`  ${chalk.yellow(f.severity)} ${chalk.dim(f.category)} ${f.filePath}:${f.line}`);
            console.log(`    ${f.body.split('\n')[0].slice(0, 100)}`);
          }
          return;
        }

        if (pending.length === 0) {
          console.log(chalk.dim('All findings already published — use --force to re-publish.'));
          return;
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = await getDefaultRepo();
        const ws = new WorkspaceManager(process.cwd());

        let published = 0;
        for (const finding of pending) {
          try {
            const createdThreadId = await orchestrator.publishFinding(finding, defaultRepo);
            console.log(chalk.green(`  ✓ ${finding.filePath}:${finding.line} (${finding.severity})`));
            finding.published = true;
            published++;
            await ws.appendPublishedAction({
              type: 'finding',
              threadId: createdThreadId,
              filePath: finding.filePath,
              line: finding.line,
              detail: `${finding.severity} ${finding.category}: ${finding.body.split('\n')[0].slice(0, 60)}`,
              publishedAt: new Date().toISOString(),
              createdThreadId,
            });
          } catch (err) {
            console.error(chalk.red(`  ✗ ${finding.filePath}:${finding.line}: ${err instanceof Error ? err.message : String(err)}`));
          }
        }

        // Persist published state
        await saveFindings(filePath, findings);

        const skipped = findings.length - pending.length;
        console.log('');
        console.log(chalk.green(`Done: ${published}/${pending.length} findings published`) +
          (skipped > 0 ? chalk.dim(` (${skipped} already published)`) : ''));
      } catch (err) {
        handleError(err);
      }
    });
}
