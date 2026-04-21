import type { Command } from 'commander';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerReviewCommand(program: Command): void {
  program
    .command('review [ref]')
    .description('Review a MR/PR: fetch context, classify threads, generate summary, write CONTEXT.md')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--full', 'Force a full review, ignoring previous session state')
    .action(async (ref: string | undefined, opts: { json?: boolean; repo?: string; full?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        const result = await orchestrator.review(ref, defaultRepo, {
          full: opts.full,
        });

        if (opts.json) {
          outputJson({
            sessionId: result.bundle.sessionId,
            createdAt: result.bundle.createdAt,
            targetId: result.bundle.target.targetId,
            title: result.bundle.target.title,
            state: result.bundle.target.state,
            incremental: result.incremental,
            threadCount: result.bundle.threads.length,
            findingCount: result.findings.length,
            diffCount: result.bundle.diffs.length,
            contextPath: result.contextPath,
          });
          return;
        }

        const { bundle, findings, incremental } = result;
        const target = bundle.target;
        const stateColor = getStateColor(target.state);

        console.log(chalk.green(`✓ Review bundle ready${incremental ? ' (incremental)' : ''}`));
        console.log('');
        console.log(`  ${chalk.bold(`!${target.targetId}`)}: ${target.title}`);
        console.log(`  ${chalk.dim('State:')}       ${stateColor(target.state)}`);
        console.log(`  ${chalk.dim('Author:')}      @${target.author}`);
        console.log(`  ${chalk.dim('Branch:')}      ${target.sourceBranch} → ${target.targetBranch}`);
        console.log(`  ${chalk.dim('Updated:')}     ${formatDate(target.updatedAt)}`);
        console.log(`  ${chalk.dim('Threads:')}     ${bundle.threads.length} unresolved`);
        console.log(`  ${chalk.dim('Files:')}       ${bundle.diffs.length} changed`);
        console.log(`  ${chalk.dim('Versions:')}    ${bundle.versions.length}`);
        console.log('');

        // Findings by severity
        if (findings.length > 0) {
          const bySeverity = new Map<string, number>();
          for (const f of findings) {
            bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
          }
          const parts = [...bySeverity.entries()].map(([s, n]) => `${n} ${s}`);
          console.log(`  ${chalk.dim('Findings:')}    ${parts.join(', ')}`);
          console.log('');
        }

        // Key paths
        const bundleDir = bundle.outputDir.replace(/[/\\]outputs$/, '');
        console.log(`  ${chalk.dim('Bundle:')}      ${bundleDir}`);
        console.log(`  ${chalk.dim('Context:')}     ${result.contextPath}`);
        console.log('');

        // Warnings
        if (target.state === 'merged') {
          console.log(chalk.yellow('  ⚠ This MR is already merged'));
          console.log('');
        } else if (target.state === 'closed') {
          console.log(chalk.yellow('  ⚠ This MR is closed'));
          console.log('');
        }

        // Next steps
        console.log(chalk.dim('Next steps:'));
        console.log(chalk.dim('  • Open .review-assist/CONTEXT.md and point your agent at it'));
        console.log(chalk.dim('  • Or use a Copilot prompt: /review-threads or /review-quick'));
        if (incremental) {
          console.log(chalk.dim('  • Re-run `review-assist review` to pick up new changes'));
          console.log(chalk.dim('  • Use --full to discard session and start fresh'));
        } else {
          console.log(chalk.dim('  • Re-run `review-assist review` after changes for an incremental update'));
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
