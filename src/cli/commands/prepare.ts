import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare <ref>')
    .description('Prepare agent-ready workspace bundle for a review target')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--thread <ids...>', 'Specific thread IDs to include')
    .option('--checkout', 'Checkout the source branch before preparing')
    .action(async (ref: string, opts: { json?: boolean; repo?: string; thread?: string[]; checkout?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        const bundle = await orchestrator.prepare(ref, defaultRepo, {
          threadIds: opts.thread,
          checkout: opts.checkout,
        });

        if (opts.json) {
          outputJson({
            sessionId: bundle.sessionId,
            createdAt: bundle.createdAt,
            targetId: bundle.target.targetId,
            title: bundle.target.title,
            threadCount: bundle.threads.length,
            diffCount: bundle.diffs.length,
            versionCount: bundle.versions.length,
            fileExcerptCount: bundle.fileExcerpts.length,
            outputDir: bundle.outputDir,
          });
          return;
        }

        console.log(chalk.green('✓ Workspace bundle prepared'));
        console.log('');
        console.log(`  ${chalk.dim('Session:')}    ${bundle.sessionId}`);
        console.log(`  ${chalk.dim('Target:')}     !${bundle.target.targetId} — ${bundle.target.title}`);
        console.log(`  ${chalk.dim('Threads:')}    ${bundle.threads.length}`);
        console.log(`  ${chalk.dim('Diffs:')}      ${bundle.diffs.length} file(s)`);
        console.log(`  ${chalk.dim('Versions:')}   ${bundle.versions.length}`);
        console.log(`  ${chalk.dim('Excerpts:')}   ${bundle.fileExcerpts.length}`);
        console.log('');
        console.log(`  Bundle location: ${chalk.underline(bundle.outputDir.replace(/[/\\]outputs$/, ''))}`);

        if (bundle.instructions.claudeMd) console.log(`  ${chalk.dim('Found CLAUDE.md')}`);
        if (bundle.instructions.reviewMd) console.log(`  ${chalk.dim('Found REVIEW.md')}`);
        if (bundle.instructions.projectRules) console.log(`  ${chalk.dim('Found project review rules')}`);
      } catch (err) {
        handleError(err);
      }
    });
}
