import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import type { NewFinding } from '../../core/types.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

const DEFAULT_FINDINGS_FILE = '.review-assist/outputs/new-findings.json';

async function loadNewFindings(filePath: string): Promise<NewFinding[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read ${filePath}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as NewFinding[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of { filePath, line, body, severity, category } objects`);
  }
}

async function saveFindings(filePath: string, entries: NewFinding[]): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

/** Severity → emoji mapping for finding comment headers. */
const SEVERITY_ICON: Record<string, string> = {
  blocker: '🔴',
  high: '🔴',
  medium: '🟡',
  low: '🟢',
  info: '🟢',
  nit: '🟢',
};

/** Build the header line prepended to published finding comments. */
function buildFindingHeader(severity: string, category: string): string {
  const icon = SEVERITY_ICON[severity] ?? '🟡';
  const sevLabel = severity.charAt(0).toUpperCase() + severity.slice(1);
  return `_${icon} ${sevLabel}_ | _${category}_\n\n`;
}

export function registerPublishFindingCommand(program: Command): void {
  program
    .command('publish-finding')
    .description([
      'Publish agent-generated findings as new discussion threads.',
      '  Reads from outputs/new-findings.json by default.',
      '  Published entries are removed from the file.',
    ].join('\n'))
    .option('--from <file>', `Findings JSON file (default: ${DEFAULT_FINDINGS_FILE})`)
    .option('--dry-run', 'Show what would be published without creating threads')
    .action(async (opts: { from?: string; dryRun?: boolean }) => {
      try {
        const filePath = opts.from ?? DEFAULT_FINDINGS_FILE;
        const findings = await loadNewFindings(filePath);

        if (findings.length === 0) {
          console.log(chalk.dim('No new findings to publish.'));
          return;
        }

        if (opts.dryRun) {
          console.log(chalk.bold(`${findings.length} finding(s) would be published:\n`));
          for (const f of findings) {
            console.log(`  ${chalk.yellow(f.severity)} ${chalk.dim(f.category)} ${f.filePath}:${f.line}`);
            console.log(`    ${f.body.split('\n')[0].slice(0, 100)}`);
          }
          return;
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = await getDefaultRepo();
        const ws = new WorkspaceManager(process.cwd());

        let published = 0;
        const remaining: NewFinding[] = [];
        for (const finding of findings) {
          try {
            const body = buildFindingHeader(finding.severity, finding.category) + finding.body;
            const createdThreadId = await orchestrator.publishFinding(
              { ...finding, body },
              defaultRepo,
            );
            console.log(chalk.green(`  ✓ ${finding.filePath}:${finding.line} (${finding.severity})`));
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
            remaining.push(finding); // keep failed entries
          }
        }

        // Remove published entries, keep only failed ones
        await saveFindings(filePath, remaining);

        console.log('');
        console.log(chalk.green(`Done: ${published}/${findings.length} findings published`));
      } catch (err) {
        handleError(err);
      }
    });
}
