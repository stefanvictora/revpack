import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, handleError } from '../helpers.js';

export function registerResetCommand(program: Command): void {
  program
    .command('reset')
    .description('Clear the active review session (or the entire bundle with --full)')
    .option('--full', 'Remove the entire .review-assist/ directory')
    .action(async (opts: { full?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        await orchestrator.reset({ full: opts.full });

        if (opts.full) {
          console.log(chalk.green('✓ Bundle removed (.review-assist/)'));
        } else {
          console.log(chalk.green('✓ Session cleared'));
        }
        console.log(chalk.dim('Run `review-assist review` to start a fresh review.'));
      } catch (err) {
        handleError(err);
      }
    });
}
