import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

const DEFAULT_REVIEW_NOTES_FILE = '.review-assist/outputs/review-notes.md';

export function registerSyncReviewCommentCommand(program: Command): void {
  program
    .command('sync-review-comment')
    .description([
      'Create or update the review comment on the MR/PR.',
      '  Reads from outputs/review-notes.md by default.',
      '  The comment is identified by a marker and updated in-place.',
    ].join('\n'))
    .option('--from <file>', `Review notes file (default: ${DEFAULT_REVIEW_NOTES_FILE})`)
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (opts: { from?: string; repo?: string }) => {
      try {
        const filePath = opts.from ?? DEFAULT_REVIEW_NOTES_FILE;
        let content: string;
        try {
          content = await fs.readFile(filePath, 'utf-8');
        } catch {
          console.error(chalk.red(`Cannot read ${filePath}`));
          console.error(chalk.dim('Run a review and have the agent write outputs/review-notes.md'));
          process.exit(1);
        }

        if (!content.trim()) {
          console.log(chalk.dim('Review notes file is empty — nothing to sync.'));
          return;
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        const result = await orchestrator.syncReviewComment(content, defaultRepo);
        if (result.created) {
          console.log(chalk.green('✓ Review comment created on the MR'));
        } else {
          console.log(chalk.green('✓ Review comment updated on the MR'));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
