import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [ref]')
    .description('Show current review status for a MR/PR')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .action(async (ref: string | undefined, opts: { json?: boolean; repo?: string }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();
        const target = await orchestrator.open(ref, defaultRepo);

        if (opts.json) {
          outputJson(target);
          return;
        }

        const mrType = target.targetType === 'merge_request' ? 'MR' : 'PR';
        const stateColor = getStateColor(target.state);

        console.log(chalk.bold(`${mrType} !${target.targetId}: ${target.title}`));
        console.log('');
        console.log(`  ${chalk.dim('State:')}     ${stateColor(target.state)}`);
        console.log(`  ${chalk.dim('Author:')}    @${target.author}`);
        console.log(`  ${chalk.dim('Branch:')}    ${target.sourceBranch} → ${target.targetBranch}`);
        console.log(`  ${chalk.dim('Created:')}   ${formatDate(target.createdAt)}`);
        console.log(`  ${chalk.dim('Updated:')}   ${formatDate(target.updatedAt)}`);
        if (target.labels.length) {
          console.log(`  ${chalk.dim('Labels:')}    ${target.labels.join(', ')}`);
        }
        console.log(`  ${chalk.dim('URL:')}       ${target.webUrl}`);

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

function getStateColor(state: string): (text: string) => string {
  switch (state) {
    case 'opened': return chalk.green;
    case 'merged': return chalk.magenta;
    case 'closed': return chalk.red;
    case 'locked': return chalk.yellow;
    default: return chalk.white;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const formatted = d.toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric',
    });

    if (diffDays === 0) return `${formatted} (today)`;
    if (diffDays === 1) return `${formatted} (yesterday)`;
    if (diffDays < 30) return `${formatted} (${diffDays} days ago)`;
    return formatted;
  } catch {
    return iso;
  }
}
