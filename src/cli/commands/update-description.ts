import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

export function registerUpdateDescriptionCommand(program: Command): void {
  program
    .command('update-description <ref>')
    .description('Update the MR/PR description')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--from <file>', 'Read description from a file')
    .option('--from-summary', 'Use the generated summary.md from the workspace bundle')
    .action(async (ref: string, opts: { repo?: string; from?: string; fromSummary?: boolean }) => {
      try {
        let body: string;
        if (opts.from) {
          body = await fs.readFile(opts.from, 'utf-8');
        } else if (opts.fromSummary) {
          try {
            body = await fs.readFile('.review-assist/outputs/summary.md', 'utf-8');
          } catch {
            console.error(chalk.red('No summary found. Run `review-assist summarize` first.'));
            process.exit(1);
          }
        } else {
          console.error(chalk.red('Provide --from <file> or --from-summary'));
          process.exit(1);
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        await orchestrator.updateDescription(ref, body, defaultRepo);
        console.log(chalk.green(`✓ Description updated for ${ref}`));
      } catch (err) {
        handleError(err);
      }
    });
}
