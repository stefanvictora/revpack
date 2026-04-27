import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [ref]')
    .description('Show target state, bundle freshness, branch sync, and pending outputs')
    .option('--json', 'Output as JSON')
    .action(async (ref: string | undefined, opts: { json?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = await getDefaultRepo();

        // Load bundle state
        const ws = new WorkspaceManager(process.cwd());
        const bundleState = await ws.loadBundleState();

        // Count unpublished outputs
        const pendingReplies = await countJsonArray('.revkit/outputs/replies.json');
        const pendingFindings = await countJsonArray('.revkit/outputs/new-findings.json');
        const hasSummary = await fileHasContent('.revkit/outputs/summary.md');
        const hasReviewNotes = await fileHasContent('.revkit/outputs/review-notes.md');

        if (opts.json) {
          const target = ref
            ? await orchestrator.open(ref, defaultRepo)
            : bundleState
              ? { ...bundleState.target }
              : await orchestrator.open(ref, defaultRepo);

          outputJson({
            target,
            bundle: bundleState ? {
              preparedAt: bundleState.preparedAt,
              mode: bundleState.prepare.mode,
              codeChanged: bundleState.prepare.codeChangedSincePreviousPrepare,
              threadsChanged: bundleState.prepare.threadsChangedSincePreviousPrepare,
              publishedActionCount: bundleState.publishedActions.length,
            } : null,
            pending: { replies: pendingReplies, findings: pendingFindings, summary: hasSummary, notes: hasReviewNotes },
          });
          return;
        }

        // If we have a bundle, show bundle-first status
        if (bundleState) {
          const t = bundleState.target;
          const mrType = t.type === 'merge_request' ? 'MR' : 'PR';
          const stateColor = getStateColor(t.state);

          console.log(chalk.bold(`${mrType} !${t.id}: ${t.title}`));
          console.log(`  ${chalk.dim('Repository:')} ${t.repository}`);
          console.log(`  ${chalk.dim('Branch:')}     ${t.sourceBranch} → ${t.targetBranch}`);
          console.log(`  ${chalk.dim('State:')}      ${stateColor(t.state)}`);
          console.log(`  ${chalk.dim('URL:')}        ${t.webUrl}`);
          console.log('');

          // Bundle info
          console.log(chalk.dim('─ Bundle ─'));
          console.log(`  ${chalk.dim('Prepared:')}   ${formatDate(bundleState.preparedAt)}`);
          console.log(`  ${chalk.dim('Head SHA:')}   ${t.diffRefs.headSha.slice(0, 7)}`);
          const ps = bundleState.prepare;
          if (ps.codeChangedSincePreviousPrepare !== null) {
            console.log(`  ${chalk.dim('Code changed since previous prepare:')} ${ps.codeChangedSincePreviousPrepare ? 'yes' : 'no'}`);
          }
          if (ps.threadsChangedSincePreviousPrepare !== null) {
            console.log(`  ${chalk.dim('Threads changed since previous prepare:')} ${ps.threadsChangedSincePreviousPrepare ? 'yes' : 'no'}`);
          }

          // Branch mismatch
          const mismatch = await orchestrator.checkBranchMismatch();
          if (mismatch) {
            console.log('');
            console.log(chalk.yellow(`  ⚠ Branch mismatch: on "${mismatch.currentBranch}" but bundle targets "${mismatch.expectedBranch}" (!${mismatch.targetId})`));
            console.log(chalk.yellow(`    Run \`revkit clean\` to remove the stale bundle, or switch to "${mismatch.expectedBranch}".`));
          }

          // Pending outputs
          if (pendingReplies > 0 || pendingFindings > 0 || hasSummary || hasReviewNotes) {
            console.log('');
            console.log(chalk.dim('─ Pending outputs ─'));
            if (pendingReplies > 0) console.log(`  ${chalk.yellow('⬡')} replies: ${pendingReplies}`);
            if (pendingFindings > 0) console.log(`  ${chalk.yellow('⬡')} findings: ${pendingFindings}`);
            if (hasSummary) console.log(`  ${chalk.yellow('⬡')} summary: changed`);
            if (hasReviewNotes) console.log(`  ${chalk.yellow('⬡')} notes: changed`);
          } else {
            console.log('');
            console.log(chalk.dim('─ Pending outputs ─'));
            console.log(chalk.dim('  (none)'));
          }

          // Published actions
          if (bundleState.publishedActions.length > 0) {
            console.log('');
            console.log(chalk.dim('─ Published actions ─'));
            console.log(`  ${bundleState.publishedActions.length} action(s) published`);
          }

          // Next step
          console.log('');
          if (pendingFindings > 0 || pendingReplies > 0) {
            console.log(chalk.dim('Next:'));
            console.log(chalk.dim('  revkit publish'));
          }

        } else {
          // No bundle — fall back to fetching target from provider
          const target = await orchestrator.open(ref, defaultRepo);
          const mrType = target.targetType === 'merge_request' ? 'MR' : 'PR';
          const stateColor = getStateColor(target.state);

          console.log(chalk.bold(`${mrType} !${target.targetId}: ${target.title}`));
          console.log('');
          console.log(`  ${chalk.dim('State:')}     ${stateColor(target.state)}`);
          console.log(`  ${chalk.dim('Author:')}    @${target.author}`);
          console.log(`  ${chalk.dim('Branch:')}    ${target.sourceBranch} → ${target.targetBranch}`);
          console.log(`  ${chalk.dim('URL:')}       ${target.webUrl}`);
          console.log('');
          console.log(chalk.dim('No bundle prepared. Run `revkit prepare` to create one.'));
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

async function countJsonArray(filePath: string): Promise<number> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

async function fileHasContent(filePath: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return raw.trim().length > 0;
  } catch {
    return false;
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
