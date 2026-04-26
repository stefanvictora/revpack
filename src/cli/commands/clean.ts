import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import { handleError } from '../helpers.js';

export function registerCleanCommand(program: Command): void {
  program
    .command('clean')
    .description('Delete local .review-assist/ bundle (disposable generated state)')
    .action(async () => {
      try {
        const bundleDir = path.join(process.cwd(), '.review-assist');
        try {
          await fs.rm(bundleDir, { recursive: true, force: true });
          console.log(chalk.green('✓ Removed .review-assist/'));
        } catch {
          console.log(chalk.dim('Nothing to clean — .review-assist/ does not exist.'));
        }
        console.log('');
        console.log(chalk.dim('.review-assist/ is disposable local state. This does not affect the MR/PR or published comments.'));
        console.log(chalk.dim('Run `review-assist prepare` to create a fresh bundle.'));
      } catch (err) {
        handleError(err);
      }
    });
}
