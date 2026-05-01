import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, createOrchestratorAt, getRepoFromGit, handleError } from '../helpers.js';

export function registerCheckoutCommand(program: Command): void {
  program
    .command('checkout <ref>')
    .description(
      [
        'Fetch and check out the MR/PR source branch locally.',
        '  In a git repo: fetches the branch and switches to it.',
        '  Outside a git repo: shallow-clones into a new directory first.',
      ].join('\n'),
    )
    .option('--prepare', 'Also run `prepare` after checkout')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string, opts: { prepare?: boolean; repo?: string }) => {
      try {
        let orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? (await getRepoFromGit());

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

        // Auto-prepare if --prepare
        if (opts.prepare) {
          console.log(chalk.dim('Running prepare...'));
          console.log('');

          const prepareResult = await orchestrator.prepare(ref, defaultRepo, { fresh: true });
          const { bundle } = prepareResult;

          console.log(chalk.green('✓ Bundle prepared'));
          console.log(`  ${chalk.dim('Threads:')}  ${bundle.threads.length} unresolved`);
          console.log(`  ${chalk.dim('Files:')}    ${bundle.diffs.length} changed`);
          console.log(`  ${chalk.dim('Context:')}  ${prepareResult.contextPath}`);
          console.log('');
          console.log(chalk.dim('Next: open .revkit/CONTEXT.md and point your agent at it'));
          if (clonedTo) {
            console.log(chalk.dim(`      cd ${clonedTo}`));
          }
        } else {
          console.log(chalk.dim('Next: run `revkit prepare` to generate the review bundle'));
          if (clonedTo) {
            console.log(chalk.dim(`      cd ${clonedTo}`));
          }
        }
      } catch (err) {
        handleError(err);
      }
    });
}
