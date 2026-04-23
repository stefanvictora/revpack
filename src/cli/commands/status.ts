import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status [ref]')
    .description('Show current review status for a MR/PR')
    .option('--json', 'Output as JSON')
    .action(async (ref: string | undefined, opts: { json?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = await getDefaultRepo();
        const target = await orchestrator.open(ref, defaultRepo);

        // Load workspace state for enhanced info
        const ws = new WorkspaceManager(process.cwd());
        const session = await ws.loadSession();

        // Count unpublished outputs
        const pendingReplies = await countJsonArray('.review-assist/outputs/replies.json');
        const pendingFindings = await countJsonArray('.review-assist/outputs/new-findings.json');
        const hasReviewNotes = await fileHasContent('.review-assist/outputs/review-notes.md');

        if (opts.json) {
          outputJson({
            ...target,
            session: session ? {
              id: session.id,
              createdAt: session.createdAt,
              lastReviewedVersionId: session.lastReviewedVersionId,
              publishedActionCount: session.publishedActions?.length ?? 0,
            } : null,
            pending: { replies: pendingReplies, findings: pendingFindings, notes: hasReviewNotes },
          });
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

        // Session info
        if (session) {
          console.log('');
          console.log(chalk.dim('─ Session ─'));
          console.log(`  ${chalk.dim('Session:')}   ${session.id.slice(0, 8)} (${formatDate(session.createdAt)})`);
          if (session.publishedActions?.length) {
            console.log(`  ${chalk.dim('Actions:')}   ${session.publishedActions.length} published`);
          }
        }

        // Pending outputs
        if (pendingReplies > 0 || pendingFindings > 0 || hasReviewNotes) {
          console.log('');
          console.log(chalk.dim('─ Pending ─'));
          if (pendingReplies > 0) console.log(`  ${chalk.yellow('⬡')} ${pendingReplies} reply/replies ready to publish`);
          if (pendingFindings > 0) console.log(`  ${chalk.yellow('⬡')} ${pendingFindings} finding(s) ready to publish`);
          if (hasReviewNotes) console.log(`  ${chalk.yellow('⬡')} Review notes ready to sync`);
          console.log(chalk.dim(`  → Run \`review-assist publish\` to publish all`));
        }

        // Branch mismatch warning
        const mismatch = await orchestrator.checkBranchMismatch();
        if (mismatch) {
          console.log('');
          console.log(chalk.yellow(`  ⚠ Branch mismatch: on "${mismatch.currentBranch}" but session targets "${mismatch.expectedBranch}" (!${mismatch.targetId})`));
          console.log(chalk.yellow(`    Run \`review-assist reset\` to clear, or \`review-assist checkout !${mismatch.targetId}\` to switch.`));
        }

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
