import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerSummarizeCommand(program: Command): void {
  program
    .command('summarize <ref>')
    .description('Generate a walkthrough and summary for a review target')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string, opts: { json?: boolean; repo?: string }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        const { summary, markdown } = await orchestrator.summarize(ref, defaultRepo);

        if (opts.json) {
          outputJson(summary);
          return;
        }

        console.log(markdown);
        console.log('');
        console.log(chalk.dim(`Summary written to .review-assist/outputs/summary.md`));
      } catch (err) {
        handleError(err);
      }
    });
}
