import type { Command } from 'commander';
import chalk from 'chalk';
import { createLocalOrchestrator, createOrchestrator, getRepoFromGit, handleError, outputJson } from '../helpers.js';

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare [ref]')
    .description('Fetch MR/PR data and generate/refresh the .revpack/ bundle')
    .option('--json', 'Output as JSON')
    .option('--local', 'Prepare a local Git review bundle instead of a PR/MR bundle')
    .option('--fresh', 'Delete existing bundle and prepare from scratch')
    .option('--discard-outputs', 'Clear pending outputs before preparing')
    .action(
      async (
        ref: string | undefined,
        opts: { json?: boolean; local?: boolean; fresh?: boolean; discardOutputs?: boolean },
      ) => {
        try {
          const orchestrator = opts.local
            ? createLocalOrchestrator(ref)
            : await createOrchestrator(undefined, undefined, { allowActiveLocal: !ref });
          const defaultRepo = opts.local ? undefined : await getRepoFromGit();
          const onProgress = opts.json ? undefined : createPrepareFetchLogger();

          const result = await orchestrator.prepare(opts.local ? undefined : ref, defaultRepo, {
            fresh: opts.fresh,
            discardOutputs: opts.discardOutputs,
            onProgress,
          });

          if (opts.json) {
            outputJson({
              preparedAt: result.bundle.preparedAt,
              targetId: result.bundle.target.targetId,
              title: result.bundle.target.title,
              state: result.bundle.target.state,
              mode: result.mode,
              targetCodeChanged: result.targetCodeChanged,
              threadsChanged: result.threadsChanged,
              descriptionChanged: result.descriptionChanged,
              hasCheckpoint: result.hasCheckpoint,
              threadCount: result.bundle.threads.length,
              diffCount: result.bundle.diffs.length,
              contextPath: result.contextPath,
            });
            return;
          }

          const { bundle, mode } = result;
          const target = bundle.target;
          const stateColor = getStateColor(target.state);
          const isLocal = target.provider === 'local';
          const targetLabel =
            target.targetType === 'merge_request' ? 'MR' : target.targetType === 'pull_request' ? 'PR' : 'Local review';

          const modeLabel = mode === 'fresh' ? '' : ' (refresh)';
          console.log(chalk.green(`✓ Bundle prepared${modeLabel}`));
          console.log('');
          console.log(`  ${chalk.bold(isLocal ? target.targetId : `!${target.targetId}`)}: ${target.title}`);
          console.log(`  ${chalk.dim('State:')}       ${stateColor(target.state)}`);
          console.log(`  ${chalk.dim('Author:')}      ${isLocal ? target.author : `@${target.author}`}`);
          console.log(`  ${chalk.dim('Branch:')}      ${target.sourceBranch} → ${target.targetBranch}`);
          console.log(`  ${chalk.dim('Updated:')}     ${formatDate(target.updatedAt)}`);
          console.log(`  ${chalk.dim('Threads:')}     ${bundle.threads.length} unresolved`);
          console.log(`  ${chalk.dim('Files:')}       ${bundle.diffs.length} changed`);
          console.log('');

          // Prepare summary — changes
          if (result.hasCheckpoint) {
            console.log(`  ${chalk.dim('Changes since last review checkpoint:')}`);
            console.log(`    ${chalk.dim('Target code:')}     ${result.targetCodeChanged ? 'yes' : 'no'}`);
            console.log(
              `    ${chalk.dim('Threads/replies:')} ${result.threadsChanged != null ? (result.threadsChanged ? 'yes' : 'no') : 'unknown'}`,
            );
            console.log(
              `    ${chalk.dim('Description:')}     ${result.descriptionChanged != null ? (result.descriptionChanged ? 'yes' : 'no') : 'unknown'}`,
            );

            if (result.prunedReplies > 0) {
              console.log(`    ${chalk.dim('Stale replies pruned:')} ${result.prunedReplies}`);
            }
            if (result.publishedActionCount > 0) {
              console.log(`    ${chalk.dim('Prior actions tracked:')} ${result.publishedActionCount}`);
            }
            console.log('');

            // Focus guidance
            if (result.targetCodeChanged) {
              console.log(`  ${chalk.dim('Focus: updated diff and unresolved thread updates')}`);
            } else if (result.threadsChanged) {
              console.log(`  ${chalk.dim('Focus: updated threads/replies and pending outputs')}`);
            } else {
              console.log(`  ${chalk.dim('Focus: pending outputs, if any')}`);
            }
            console.log('');
          } else if (mode !== 'fresh') {
            console.log(`  ${chalk.dim('No review checkpoint found — treat as fresh review')}`);
            console.log('');
          }

          // Key paths
          const bundleDir = bundle.bundlePath;
          console.log(`  ${chalk.dim('Bundle:')}      ${bundleDir}`);
          console.log(`  ${chalk.dim('Context:')}     ${result.contextPath}`);
          console.log('');

          // Warnings
          if (target.state === 'merged') {
            console.log(chalk.yellow(`  ⚠ This ${targetLabel} is already merged`));
            console.log('');
          } else if (target.state === 'closed') {
            console.log(chalk.yellow(`  ⚠ This ${targetLabel} is closed`));
            console.log('');
          }

          // Next steps
          console.log(chalk.dim('Next steps:'));
          console.log(chalk.dim('  • Open .revpack/CONTEXT.md and point your agent at it'));
          console.log(chalk.dim('  • Or use a Copilot prompt: /review or /review-summarize'));
          console.log(chalk.dim('  • Re-run `revpack prepare` after changes to refresh'));
        } catch (err) {
          handleError(err);
        }
      },
    );
}

function createPrepareFetchLogger(): (message: string) => void {
  return (message: string) => {
    console.log(chalk.dim(message));
  };
}

function getStateColor(state: string): (text: string) => string {
  switch (state) {
    case 'opened':
      return chalk.green;
    case 'merged':
      return chalk.magenta;
    case 'closed':
      return chalk.red;
    case 'locked':
      return chalk.yellow;
    default:
      return chalk.white;
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    const formatted = d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

    if (diffDays === 0) return `${formatted} (today)`;
    if (diffDays === 1) return `${formatted} (yesterday)`;
    if (diffDays < 30) return `${formatted} (${diffDays} days ago)`;
    return formatted;
  } catch {
    return iso;
  }
}
