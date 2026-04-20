import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

export function registerPublishReplyCommand(program: Command): void {
  program
    .command('publish-reply <ref> <threadId>')
    .description('Publish a reply to a review thread')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--from <file>', 'Read reply body from a file')
    .option('--body <text>', 'Reply body text')
    .option('--resolve', 'Also resolve the thread after replying')
    .action(async (ref: string, threadId: string, opts: { repo?: string; from?: string; body?: string; resolve?: boolean }) => {
      try {
        let body: string;
        if (opts.from) {
          body = await fs.readFile(opts.from, 'utf-8');
        } else if (opts.body) {
          body = opts.body;
        } else {
          console.error(chalk.red('Provide --body or --from <file>'));
          process.exit(1);
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        await orchestrator.publishReply(ref, threadId, body, defaultRepo);
        console.log(chalk.green(`✓ Reply posted to thread ${threadId}`));

        if (opts.resolve) {
          await orchestrator.resolveThread(ref, threadId, defaultRepo);
          console.log(chalk.green(`✓ Thread ${threadId} resolved`));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
