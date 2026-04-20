import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerThreadsCommand(program: Command): void {
  program
    .command('threads <ref>')
    .description('List review threads for a target')
    .option('--json', 'Output as JSON')
    .option('--all', 'Include resolved threads')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string, opts: { json?: boolean; all?: boolean; repo?: string }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();
        const { threads, classifications } = await orchestrator.threads(ref, defaultRepo, { all: opts.all });

        if (opts.json) {
          outputJson({ threads, classifications });
          return;
        }

        if (threads.length === 0) {
          console.log(chalk.green('No unresolved threads.'));
          return;
        }

        console.log(chalk.bold(`${threads.length} thread(s)${opts.all ? ' (all)' : ' (unresolved)'}:`));
        console.log('');

        const classMap = new Map(classifications.map((c) => [c.threadId, c]));

        for (const thread of threads) {
          const cls = classMap.get(thread.threadId);
          const firstComment = thread.comments.find((c) => !c.system);
          const statusIcon = thread.resolved ? chalk.green('✓') : chalk.yellow('●');
          const severityColor = getSeverityColor(cls?.severity ?? 'info');

          console.log(`  ${statusIcon} ${chalk.dim(thread.threadId.slice(0, 8))}  ${severityColor(cls?.severity ?? '?')}  ${chalk.dim(cls?.category ?? '')}  ${chalk.dim(thread.position?.filePath ?? '(general)')}`);
          if (firstComment) {
            const summary = firstComment.body.split('\n')[0].slice(0, 80);
            console.log(`    ${chalk.dim('@' + firstComment.author + ':')} ${summary}`);
          }
          console.log('');
        }
      } catch (err) {
        handleError(err);
      }
    });
}

function getSeverityColor(severity: string): (text: string) => string {
  switch (severity) {
    case 'blocker': return chalk.bgRed.white;
    case 'high': return chalk.red;
    case 'medium': return chalk.yellow;
    case 'low': return chalk.blue;
    case 'nit': return chalk.gray;
    case 'info': return chalk.cyan;
    default: return chalk.white;
  }
}
