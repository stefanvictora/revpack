import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { formatTargetDisplayId, formatTargetKind } from '../../core/display.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { GitHelper } from '../../workspace/git-helper.js';
import { createOrchestrator, getRepoFromGit, handleError, outputJson } from '../helpers.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [ref]')
    .description('Show target, bundle, checkout, and output status')
    .option('--json', 'Output as JSON')
    .action(async (ref: string | undefined, opts: { json?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator(undefined, undefined, { allowActiveLocal: !ref });
        const defaultRepo = await getRepoFromGit();

        // Load bundle state
        const ws = new WorkspaceManager(process.cwd());
        const bundleState = await ws.loadBundleState();

        // Count unpublished outputs
        const pendingReplies = await countJsonArray('.revpack/outputs/replies.json');
        const pendingFindings = await countJsonArray('.revpack/outputs/new-findings.json');

        // Compute output states
        const summaryState = await ws.getOutputState('summary');
        const reviewState = await ws.getOutputState('review');

        if (opts.json) {
          const target = ref
            ? await orchestrator.open(ref, defaultRepo)
            : bundleState
              ? { ...bundleState.target }
              : await orchestrator.open(ref, defaultRepo);

          outputJson({
            target,
            bundle: bundleState
              ? {
                  preparedAt: bundleState.preparedAt,
                  mode: bundleState.prepare.mode,
                  targetCodeChanged: bundleState.prepare.comparison.targetCodeChangedSinceCheckpoint,
                  threadsChanged: bundleState.prepare.comparison.threadsChangedSinceCheckpoint,
                  publishedActionCount: bundleState.publishedActions.length,
                }
              : null,
            local: bundleState?.local ?? null,
            pending: {
              replies: pendingReplies,
              findings: pendingFindings,
              summary: summaryState,
              review: reviewState,
            },
          });
          return;
        }

        // If we have a bundle, show bundle-first status
        if (bundleState) {
          const t = bundleState.target;
          const targetKind = formatTargetKind({ targetType: t.type });
          const targetDisplayId = formatTargetDisplayId({
            provider: t.provider,
            targetType: t.type,
            targetId: t.id,
          });
          const stateColor = getStateColor(t.state);

          console.log(chalk.bold(`${targetKind} ${targetDisplayId}: ${t.title}`));
          console.log(`  ${chalk.dim('Repository:')} ${t.repository}`);
          console.log(`  ${chalk.dim('Branch:')}     ${t.sourceBranch} → ${t.targetBranch}`);
          console.log(`  ${chalk.dim('State:')}      ${stateColor(t.state)}`);
          if (t.webUrl) {
            console.log(`  ${chalk.dim('URL:')}        ${t.webUrl}`);
          }
          console.log('');

          // Bundle info
          console.log(chalk.dim('─ Bundle ─'));
          console.log(`  ${chalk.dim('Prepared:')}    ${formatDate(bundleState.preparedAt)}`);
          console.log(`  ${chalk.dim('Target head:')} ${t.diffRefs.headSha.slice(0, 7)}`);
          if (bundleState.local) {
            console.log(`  ${chalk.dim('Local head:')}  ${bundleState.local.headSha.slice(0, 7)} (at prepare)`);
          }
          console.log('');

          // Local checkout info
          const git = new GitHelper(process.cwd());
          try {
            const [currentHead, currentBranch, isClean] = await Promise.all([
              git.headSha(),
              git.currentBranch(),
              git.isClean(),
            ]);
            const matchesTarget = currentHead === t.diffRefs.headSha;

            console.log(chalk.dim('─ Local checkout ─'));
            console.log(`  ${chalk.dim('Branch:')}         ${currentBranch}`);
            console.log(`  ${chalk.dim('Current HEAD:')}   ${currentHead.slice(0, 7)}`);
            if (matchesTarget) {
              console.log(`  ${chalk.dim('Matches target:')} ${chalk.green('yes')}`);
            } else {
              const isAncestor = await git.isAncestor(t.diffRefs.headSha).catch(() => false);
              const relation = isAncestor ? `ahead of ${targetKind} head` : `behind ${targetKind} head`;
              console.log(`  ${chalk.dim('Target head:')}    ${t.diffRefs.headSha.slice(0, 7)}`);
              console.log(`  ${chalk.dim('Matches target:')} ${chalk.yellow(`no — ${relation}`)}`);
              console.log('');
              console.log(chalk.dim('Next:'));
              if (!isAncestor) {
                console.log(chalk.dim('  git pull'));
              }
              console.log(chalk.dim('  revpack prepare'));
            }
            console.log(`  ${chalk.dim('Working tree:')}   ${isClean ? 'clean' : chalk.yellow('dirty')}`);
          } catch {
            // Not a git repo — skip local checkout info
          }

          // Branch mismatch
          const mismatch = await orchestrator.checkBranchMismatch();
          if (mismatch) {
            console.log('');
            console.log(
              chalk.yellow(
                `  ⚠ Branch mismatch: on "${mismatch.currentBranch}" but bundle targets "${mismatch.expectedBranch}" (${targetDisplayId})`,
              ),
            );
            console.log(
              chalk.yellow(
                `    Run \`revpack clean\` to remove the stale bundle, or switch to "${mismatch.expectedBranch}".`,
              ),
            );
          }

          // Output status
          console.log('');
          console.log(chalk.dim('─ Output status ─'));
          console.log(
            `  ${chalk.dim('Replies:')}  ${pendingReplies > 0 ? `${pendingReplies} pending` : 'none pending'}`,
          );
          console.log(
            `  ${chalk.dim('Findings:')} ${pendingFindings > 0 ? `${pendingFindings} pending` : 'none pending'}`,
          );
          console.log(`  ${chalk.dim('Summary:')}  ${formatOutputState(summaryState)}`);
          console.log(`  ${chalk.dim('Review:')}   ${formatOutputState(reviewState)}`);

          // Published actions
          if (bundleState.publishedActions.length > 0) {
            console.log('');
            console.log(chalk.dim('─ Published actions ─'));
            console.log(`  ${formatCount(bundleState.publishedActions.length, 'action')} published`);
          }

          // Next step
          console.log('');
          if (pendingFindings > 0 || pendingReplies > 0 || summaryState === 'pending' || reviewState === 'pending') {
            console.log(chalk.dim('Next:'));
            console.log(chalk.dim('  revpack publish all'));
          }
        } else {
          // No bundle — fall back to fetching target from provider
          const target = await orchestrator.open(ref, defaultRepo);
          const targetKind = formatTargetKind(target);
          const targetDisplayId = formatTargetDisplayId(target);
          const stateColor = getStateColor(target.state);

          console.log(chalk.bold(`${targetKind} ${targetDisplayId}: ${target.title}`));
          console.log('');
          console.log(`  ${chalk.dim('State:')}     ${stateColor(target.state)}`);
          console.log(`  ${chalk.dim('Author:')}    @${target.author}`);
          console.log(`  ${chalk.dim('Branch:')}    ${target.sourceBranch} → ${target.targetBranch}`);
          console.log(`  ${chalk.dim('URL:')}       ${target.webUrl}`);
          console.log('');
          console.log(chalk.dim('No bundle prepared. Run `revpack prepare` to create one.'));
        }
      } catch (err) {
        handleError(err);
      }
    });
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

async function countJsonArray(filePath: string): Promise<number> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function formatOutputState(state: string): string {
  switch (state) {
    case 'empty':
      return chalk.dim('empty');
    case 'pending':
      return chalk.yellow('pending');
    case 'published':
      return chalk.green('published');
    case 'modified since publish':
      return chalk.yellow('modified since publish');
    default:
      return state;
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

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
