import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import chalk from 'chalk';
import { handleError } from '../helpers.js';

export function registerCleanCommand(program: Command): void {
  program
    .command('clean')
    .description('Delete local .revpack/ bundle (disposable generated state)')
    .action(async () => {
      try {
        const bundleDir = path.join(process.cwd(), '.revpack');
        try {
          await fs.rm(bundleDir, { recursive: true, force: true });
          console.log(chalk.green('✓ Removed .revpack/'));
        } catch {
          console.log(chalk.dim('Nothing to clean — .revpack/ does not exist.'));
        }
        console.log('');
        console.log(
          chalk.dim('.revpack/ is disposable local state. This does not affect the MR/PR or published comments.'),
        );
        console.log(chalk.dim('Run `revpack prepare` to create a fresh bundle.'));
      } catch (err) {
        handleError(err);
      }
    });
}
