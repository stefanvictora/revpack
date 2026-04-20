import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerOpenCommand(program: Command): void {
  program
    .command('open <ref>')
    .description('Open a review target (MR/PR) and display its metadata')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string, opts: { json?: boolean; repo?: string }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();
        const target = await orchestrator.open(ref, defaultRepo);

        if (opts.json) {
          outputJson(target);
          return;
        }

        console.log(chalk.bold(`${target.targetType === 'merge_request' ? 'MR' : 'PR'} !${target.targetId}: ${target.title}`));
        console.log('');
        console.log(`  ${chalk.dim('Author:')}    @${target.author}`);
        console.log(`  ${chalk.dim('State:')}     ${target.state}`);
        console.log(`  ${chalk.dim('Source:')}    ${target.sourceBranch} → ${target.targetBranch}`);
        console.log(`  ${chalk.dim('URL:')}       ${target.webUrl}`);
        console.log(`  ${chalk.dim('Created:')}   ${target.createdAt}`);
        console.log(`  ${chalk.dim('Updated:')}   ${target.updatedAt}`);
        if (target.labels.length) {
          console.log(`  ${chalk.dim('Labels:')}    ${target.labels.join(', ')}`);
        }
        console.log(`  ${chalk.dim('Diff refs:')} base=${target.diffRefs.baseSha.slice(0, 8)} head=${target.diffRefs.headSha.slice(0, 8)} start=${target.diffRefs.startSha.slice(0, 8)}`);

        if (target.description) {
          console.log('');
          console.log(chalk.dim('─'.repeat(60)));
          console.log(target.description.slice(0, 500));
          if (target.description.length > 500) console.log(chalk.dim('... (truncated)'));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
