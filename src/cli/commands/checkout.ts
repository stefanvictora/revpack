import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, createOrchestratorAt, getDefaultRepo, handleError } from '../helpers.js';

export function registerCheckoutCommand(program: Command): void {
  program
    .command('checkout <ref>')
    .description([
      'Switch to the MR source branch and run a full review.',
      '  In a git repo: fetches the branch, switches to it, runs `review --full`.',
      '  Outside a git repo: shallow-clones into a new directory first.',
    ].join('\n'))
    .option('--no-review', 'Only switch branch, skip the automatic review')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string, opts: { review?: boolean; repo?: string }) => {
      try {
        let orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        // Switch branch (or clone if no git repo)
        const result = await orchestrator.checkout(ref, defaultRepo);
        const { branch, target, clonedTo } = result;

        if (clonedTo) {
          console.log(chalk.green(`✓ Cloned into ${clonedTo}`));
          console.log(`  ${chalk.bold(`!${target.targetId}`)}: ${target.title}`);
          console.log(`  ${chalk.dim('Branch:')} ${branch}`);
          console.log(`  ${chalk.dim('Author:')} @${target.author}`);
          console.log('');

          // Re-create orchestrator targeting the cloned directory
          orchestrator = await createOrchestratorAt(clonedTo);
        } else {
          console.log(chalk.green(`✓ Switched to branch "${branch}"`));
          console.log(`  ${chalk.bold(`!${target.targetId}`)}: ${target.title}`);
          console.log(`  ${chalk.dim('Author:')} @${target.author}`);
          console.log('');
        }

        // Auto-review unless --no-review
        if (opts.review !== false) {
          console.log(chalk.dim('Running review...'));
          console.log('');

          const reviewResult = await orchestrator.review(ref, defaultRepo, { full: true });
          const { bundle } = reviewResult;

          console.log(chalk.green('✓ Review bundle ready'));
          console.log(`  ${chalk.dim('Threads:')}  ${bundle.threads.length} unresolved`);
          console.log(`  ${chalk.dim('Files:')}    ${bundle.diffs.length} changed`);
          console.log(`  ${chalk.dim('Context:')}  ${reviewResult.contextPath}`);
          console.log('');
          console.log(chalk.dim('Next: open .review-assist/CONTEXT.md and point your agent at it'));
          if (clonedTo) {
            console.log(chalk.dim(`      cd ${clonedTo}`));
          }
        } else if (clonedTo) {
          console.log(chalk.dim(`Next: cd ${clonedTo}`));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
