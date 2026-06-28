import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import type { BundleTarget, ReviewTarget } from '../../core/types.js';
import { sameCommitSha } from '../../core/commits.js';
import { formatTargetKind } from '../../core/display.js';
import { formatTargetDisplayId } from '../../providers/display.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { GitHelper } from '../../workspace/git-helper.js';
import { createOrchestrator, getRepoFromGit, handleError, outputJson } from '../helpers.js';
import { formatGuidanceLine } from '../output.js';
import { getTargetStateColor } from '../target-state.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [ref]')
    .description('Show target, bundle, checkout, agent outputs, and publish history')
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
        const reviewState = await ws.getPendingOutputState('review');

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
          const latestTarget = await orchestrator.open(undefined, defaultRepo).catch(() => null);
          const currentTargetHead = latestTarget?.diffRefs.headSha;
          const comparisonTargetHead = currentTargetHead ?? t.diffRefs.headSha;
          const bundleIsOutdated = currentTargetHead ? !sameCommitSha(currentTargetHead, t.diffRefs.headSha) : false;
          const targetKind = formatTargetKind({ targetType: t.type });
          const targetDisplayId = formatTargetDisplayId({
            provider: t.provider,
            targetType: t.type,
            targetId: t.id,
          });
          const displayTarget = buildBundleStatusDisplayTarget(t, latestTarget);
          const stateColor = getTargetStateColor(displayTarget.state);
          const hasPublishableSummary = isPublishableOutputState(summaryState);
          const hasPublishableReview = isPublishableOutputState(reviewState);

          console.log(chalk.bold(`${targetKind} ${targetDisplayId}: ${displayTarget.title}`));
          console.log(`  ${chalk.dim('Repository:')} ${displayTarget.repository}`);
          console.log(`  ${chalk.dim('State:')}      ${stateColor(displayTarget.state)}`);
          console.log(`  ${chalk.dim('Author:')}     @${displayTarget.author}`);
          console.log(`  ${chalk.dim('Branch:')}     ${displayTarget.sourceBranch} → ${displayTarget.targetBranch}`);
          console.log(`  ${chalk.dim(`Updated:`)}    ${formatDate(displayTarget.updatedAt)}`);

          if (displayTarget.webUrl) {
            console.log(`  ${chalk.dim('URL:')}        ${displayTarget.webUrl}`);
          }
          console.log('');

          // Bundle info
          console.log(chalk.dim('─ Bundle ─'));
          console.log(`  ${chalk.dim('Prepared:')}         ${formatDate(bundleState.preparedAt)}`);
          console.log(`  ${chalk.dim(`Prepared ${targetKind} head:`)} ${t.diffRefs.headSha.slice(0, 7)}`);
          if (currentTargetHead) {
            console.log(`  ${chalk.dim(`Latest ${targetKind} head:`)}   ${currentTargetHead.slice(0, 7)}`);
          }
          console.log(
            `  ${chalk.dim('Status:')}           ${formatBundleFreshnessState(currentTargetHead, bundleIsOutdated, targetKind)}`,
          );
          console.log('');

          // Local checkout info
          const git = new GitHelper(process.cwd());
          let checkoutRelation: CheckoutRelation = 'unknown';
          try {
            const [currentHead, currentBranch] = await Promise.all([git.headSha(), git.currentBranch()]);
            console.log(chalk.dim('─ Checkout ─'));
            console.log(`  ${chalk.dim('Branch:')}           ${currentBranch}`);
            console.log(`  ${chalk.dim('Current HEAD:')}     ${currentHead.slice(0, 7)}`);
            checkoutRelation = await compareCheckoutToTargetHead(git, comparisonTargetHead, currentHead);
            const status = formatCheckoutState(checkoutRelation, comparisonTargetHead, targetKind);
            console.log(`  ${chalk.dim(`Status:`)}           ${status}`);
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

          // Publish status
          console.log('');
          console.log(chalk.dim('─ Publish status ─'));
          console.log(
            `  ${chalk.dim('Replies:')}          ${pendingReplies > 0 ? `${pendingReplies} pending` : chalk.dim('none')}`,
          );
          console.log(
            `  ${chalk.dim('Findings:')}         ${pendingFindings > 0 ? `${pendingFindings} pending` : chalk.dim('none')}`,
          );
          console.log(`  ${chalk.dim('Summary:')}          ${formatOutputState(summaryState)}`);
          console.log(`  ${chalk.dim('Review note:')}      ${formatOutputState(reviewState)}`);
          const checkpointState = getCheckpointState(bundleState);
          console.log(`  ${chalk.dim('Checkpoint:')}       ${formatCheckpointState(checkpointState)}`);

          // Next step
          console.log('');
          const needsCheckpoint = checkpointState !== 'current';

          if (bundleIsOutdated) {
            console.log(formatGuidanceLine('Next:'));
            console.log(formatGuidanceLine('  revpack prepare'));
            const pendingOlderBundleLines = buildPendingOlderBundleLines({
              repliesReady: pendingReplies > 0,
              findingsReady: pendingFindings > 0,
              summaryReady: hasPublishableSummary,
              reviewReady: hasPublishableReview,
            });
            if (pendingOlderBundleLines.length > 0) {
              console.log('');
              for (const line of pendingOlderBundleLines) {
                console.log(chalk.dim(line));
              }
            }
          } else if (!mismatch) {
            for (const line of buildStatusNextLines({
              repliesReady: pendingReplies > 0,
              findingsReady: pendingFindings > 0,
              summaryReady: hasPublishableSummary,
              reviewReady: hasPublishableReview,
              checkpointDue: needsCheckpoint,
              checkoutRelation,
            })) {
              console.log(formatGuidanceLine(line));
            }
          }
        } else {
          // No bundle — fall back to fetching target from provider
          const target = await orchestrator.open(ref, defaultRepo);
          const targetKind = formatTargetKind(target);
          const targetDisplayId = formatTargetDisplayId(target);
          const stateColor = getTargetStateColor(target.state);

          console.log(chalk.bold(`${targetKind} ${targetDisplayId}: ${target.title}`));
          console.log('');
          console.log(`  ${chalk.dim('State:')}     ${stateColor(target.state)}`);
          console.log(`  ${chalk.dim('Author:')}    @${target.author}`);
          console.log(`  ${chalk.dim('Branch:')}    ${target.sourceBranch} → ${target.targetBranch}`);
          console.log(`  ${chalk.dim('URL:')}       ${target.webUrl}`);
          console.log('');
          console.log(formatGuidanceLine('No bundle prepared.'));
          console.log('');
          console.log(formatGuidanceLine('Next:'));
          console.log(formatGuidanceLine('  revpack prepare'));
        }
      } catch (err) {
        handleError(err);
      }
    });
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

type CheckpointState = 'none' | 'current' | 'outdated' | 'unknown';
type CheckoutRelation = 'current' | 'ahead' | 'behind' | 'diverged' | 'unknown';
type BundleStatusDisplayTarget = Pick<
  BundleTarget,
  'title' | 'repository' | 'state' | 'author' | 'sourceBranch' | 'targetBranch' | 'updatedAt' | 'webUrl'
>;

export function buildBundleStatusDisplayTarget(
  bundleTarget: BundleTarget,
  latestTarget: ReviewTarget | null,
): BundleStatusDisplayTarget {
  if (!latestTarget) {
    return bundleTarget;
  }

  return {
    title: latestTarget.title,
    repository: latestTarget.repository,
    state: latestTarget.state,
    author: latestTarget.author,
    sourceBranch: latestTarget.sourceBranch,
    targetBranch: latestTarget.targetBranch,
    updatedAt: latestTarget.updatedAt,
    webUrl: latestTarget.webUrl,
  };
}

function getCheckpointState(bundleState: {
  prepare: {
    checkpoint: unknown;
    comparison: {
      targetCodeChangedSinceCheckpoint: boolean | null;
      threadsChangedSinceCheckpoint: boolean | null;
      descriptionChangedSinceCheckpoint: boolean | null;
    };
  };
}): CheckpointState {
  if (!bundleState.prepare.checkpoint) return 'none';

  const comparison = bundleState.prepare.comparison;
  const values = [
    comparison.targetCodeChangedSinceCheckpoint,
    comparison.threadsChangedSinceCheckpoint,
    comparison.descriptionChangedSinceCheckpoint,
  ];

  if (values.some((value) => value === true)) return 'outdated';
  if (values.every((value) => value === false)) return 'current';
  return 'unknown';
}

function formatCheckpointState(state: CheckpointState): string {
  switch (state) {
    case 'none':
      return chalk.yellow('not recorded');
    case 'current':
      return chalk.green('current');
    case 'outdated':
      return chalk.yellow('needs update');
    case 'unknown':
      return chalk.yellow('unknown');
  }
}

function formatBundleFreshnessState(
  currentTargetHead: string | undefined,
  bundleIsOutdated: boolean,
  targetKind: string,
): string {
  if (!currentTargetHead) return chalk.yellow('unknown');
  return bundleIsOutdated
    ? chalk.yellow(`stale — prepared for older ${targetKind} head`)
    : chalk.green(`current — matches latest ${targetKind} head`);
}

export async function compareCheckoutToTargetHead(
  git: GitHelper,
  comparisonTargetHead: string,
  currentHead: string,
): Promise<CheckoutRelation> {
  if (sameCommitSha(currentHead, comparisonTargetHead)) {
    return 'current';
  }

  const [targetExists, currentExists] = await Promise.all([
    git.hasCommit(comparisonTargetHead),
    git.hasCommit(currentHead),
  ]);
  if (!targetExists || !currentExists) {
    return 'unknown';
  }

  const targetIsAncestorOfCurrent = await git.isAncestor(comparisonTargetHead, currentHead);
  const currentIsAncestorOfTarget = await git.isAncestor(currentHead, comparisonTargetHead);
  if (targetIsAncestorOfCurrent) {
    return 'ahead';
  }
  if (currentIsAncestorOfTarget) {
    return 'behind';
  }
  return 'diverged';
}

function formatCheckoutState(relation: CheckoutRelation, comparisonTargetHead: string, targetKind: string): string {
  switch (relation) {
    case 'current':
      return chalk.green(`current — matches latest ${targetKind} head`);
    case 'ahead':
      return chalk.yellow(`ahead — local HEAD is not in the ${targetKind} yet`);
    case 'behind':
      return chalk.yellow(`behind — latest ${targetKind} head is ${comparisonTargetHead.slice(0, 7)}`);
    case 'diverged':
      return chalk.yellow(`diverged — latest ${targetKind} head is ${comparisonTargetHead.slice(0, 7)}`);
    case 'unknown':
      return chalk.yellow('unknown');
  }
}

function isPublishableOutputState(state: string): boolean {
  return state === 'pending' || state === 'modified since publish';
}

export function buildStatusNextLines(options: {
  repliesReady: boolean;
  findingsReady: boolean;
  summaryReady: boolean;
  reviewReady: boolean;
  checkpointDue: boolean;
  checkoutRelation?: CheckoutRelation;
}): string[] {
  if (options.checkoutRelation === 'ahead') {
    return ['Next:', '  Push local commits, then run:', '  revpack prepare'];
  }

  const contentReady = [options.repliesReady, options.findingsReady, options.summaryReady, options.reviewReady].filter(
    Boolean,
  ).length;

  if (contentReady > 0) {
    const lines = ['Next:', '  Review .revpack/outputs/', '  revpack publish all'];
    if (contentReady >= 2) {
      const selectedCommands: string[] = [];
      if (options.repliesReady) selectedCommands.push('  revpack publish replies');
      if (options.findingsReady) selectedCommands.push('  revpack publish findings');
      if (options.summaryReady) selectedCommands.push('  revpack publish summary');
      if (options.reviewReady) selectedCommands.push('  revpack publish review');

      lines.push('', 'Or publish selected:', ...selectedCommands);
      if (options.checkpointDue) {
        lines.push('', 'After publishing selected outputs, record the review state:', '  revpack publish checkpoint');
      }
    }
    return lines;
  }

  if (options.checkpointDue) {
    return ['Next:', '  revpack publish checkpoint'];
  }

  return ['Next:', '  No pending publish action.'];
}

export function buildPendingOlderBundleLines(options: {
  repliesReady: boolean;
  findingsReady: boolean;
  summaryReady: boolean;
  reviewReady: boolean;
}): string[] {
  const lines: string[] = [];
  if (options.repliesReady) lines.push('  revpack publish replies');
  if (options.findingsReady) lines.push('  revpack publish findings');
  if (options.summaryReady) lines.push('  revpack publish summary');
  if (options.reviewReady) lines.push('  revpack publish review');

  return lines.length > 0 ? ['Still pending output from previous bundle:', '  Review .revpack/outputs/', ...lines] : [];
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
      return chalk.yellow('pending (modified)');
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
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    if (diffDays === 0) return `${formatted} (today)`;
    if (diffDays === 1) return `${formatted} (yesterday)`;
    if (diffDays < 30) return `${formatted} (${diffDays} days ago)`;
    return formatted;
  } catch {
    return iso;
  }
}
