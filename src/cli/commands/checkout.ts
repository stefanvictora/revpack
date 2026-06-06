import type { Command } from 'commander';
import chalk from 'chalk';
import { formatTargetDisplayId } from '../../core/display.js';
import { createOrchestrator, createOrchestratorAt, getRepoFromGit, handleError } from '../helpers.js';
import { formatGuidanceLine } from '../output.js';
import { runSetup } from './setup.js';

export function registerCheckoutCommand(program: Command): void {
  program
    .command('checkout <ref>')
    .description(
      [
        'Fetch and check out the PR/MR source branch locally.',
        '  In a git repo: fetches the branch and switches to it.',
        '  Outside a git repo: shallow-clones into a new directory first.',
      ].join('\n'),
    )
    .summary('Check out the PR/MR source branch locally')
    .option('--prepare', 'Deprecated: checkout prepares by default')
    .option('--setup', 'Also run `setup` after checkout and prepare')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--profile <name>', 'Profile to use (overrides auto-detection)')
    .action(async (ref: string, opts: { prepare?: boolean; setup?: boolean; repo?: string; profile?: string }) => {
      try {
        // When ref is a full URL, pass it as a hint so profile resolution can
        // match by the URL's host even outside a git repo.
        const hintUrls = /^https?:\/\//i.test(ref) ? [ref] : undefined;
        let orchestrator = await createOrchestrator(hintUrls, opts.profile, { allowActiveLocal: false });
        const defaultRepo = opts.repo ?? (await getRepoFromGit());

        // Switch branch (or clone if no git repo)
        const result = await orchestrator.checkout(ref, defaultRepo);
        const { branch, target, clonedTo } = result;
        const targetDisplayId = formatTargetDisplayId(target);

        if (clonedTo) {
          console.log(chalk.green(`✓ Cloned into ${clonedTo}`));
          console.log(`  ${chalk.bold(targetDisplayId)}: ${target.title}`);
          console.log(`  ${chalk.dim('Branch:')} ${branch}`);
          console.log(`  ${chalk.dim('Author:')} @${target.author}`);
          console.log('');

          // Re-create orchestrator targeting the cloned directory
          orchestrator = await createOrchestratorAt(clonedTo);
        } else {
          console.log(chalk.green(`✓ Switched to branch "${branch}"`));
          console.log(`  ${chalk.bold(targetDisplayId)}: ${target.title}`);
          console.log(`  ${chalk.dim('Author:')} @${target.author}`);
          console.log('');
        }

        console.log(chalk.dim('Running prepare...'));
        console.log('');

        const prepareResult = await orchestrator.prepare(ref, defaultRepo, {
          fresh: true,
          onProgress: createPrepareFetchLogger(),
        });
        const { bundle } = prepareResult;

        console.log(chalk.green('✓ Bundle prepared'));
        console.log(`  ${chalk.dim('Threads:')}  ${bundle.threads.length} unresolved`);
        console.log(`  ${chalk.dim('Files:')}    ${bundle.diffs.length} changed`);
        console.log(`  ${chalk.dim('Context:')}  ${prepareResult.contextPath}`);
        console.log('');

        // Run setup if --setup was requested
        if (opts.setup) {
          const setupCwd = clonedTo ?? process.cwd();
          console.log(chalk.dim('Running setup...'));
          console.log('');
          await runSetup({ cwd: setupCwd });
          console.log('');
        }

        console.log(formatGuidanceLine('Next:'));
        console.log(formatGuidanceLine('  Open .revpack/CONTEXT.md and point your agent at it'));
        if (clonedTo) {
          console.log(formatGuidanceLine(`  cd ${clonedTo}`));
        }
      } catch (err) {
        handleError(err);
      }
    });
}

function createPrepareFetchLogger(): (message: string) => void {
  return (message: string) => {
    console.log(chalk.dim(message));
  };
}
