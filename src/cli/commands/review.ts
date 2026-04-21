import type { Command } from 'commander';
import * as path from 'node:path';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError, outputJson } from '../helpers.js';

export function registerReviewCommand(program: Command): void {
  program
    .command('review [ref]')
    .description('Review a MR/PR: fetch context, classify threads, generate summary, write CONTEXT.md')
    .option('--json', 'Output as JSON')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--full', 'Force a full review, ignoring previous session state')
    .option('--checkout', 'Checkout the source branch before reviewing')
    .action(async (ref: string | undefined, opts: { json?: boolean; repo?: string; full?: boolean; checkout?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        const result = await orchestrator.review(ref, defaultRepo, {
          full: opts.full,
          checkout: opts.checkout,
        });

        if (opts.json) {
          outputJson({
            sessionId: result.bundle.sessionId,
            createdAt: result.bundle.createdAt,
            targetId: result.bundle.target.targetId,
            title: result.bundle.target.title,
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

        console.log(chalk.green(`✓ Review bundle ready${incremental ? ' (incremental)' : ''}`));
        console.log('');
        console.log(`  ${chalk.bold(`!${target.targetId}`)}: ${target.title}`);
        console.log(`  ${chalk.dim('Author:')}       @${target.author}`);
        console.log(`  ${chalk.dim('Branch:')}       ${target.sourceBranch} → ${target.targetBranch}`);
        console.log(`  ${chalk.dim('Threads:')}      ${bundle.threads.length} unresolved`);
        console.log(`  ${chalk.dim('Files:')}        ${bundle.diffs.length} changed`);
        console.log(`  ${chalk.dim('Versions:')}     ${bundle.versions.length}`);
        console.log('');

        // Findings by severity
        if (findings.length > 0) {
          const bySeverity = new Map<string, number>();
          for (const f of findings) {
            bySeverity.set(f.severity, (bySeverity.get(f.severity) ?? 0) + 1);
          }
          const parts = [...bySeverity.entries()].map(([s, n]) => `${n} ${s}`);
          console.log(`  ${chalk.dim('Findings:')}     ${parts.join(', ')}`);
          console.log('');
        }

        // Key paths
        const bundleDir = bundle.outputDir.replace(/[/\\]outputs$/, '');
        console.log(`  ${chalk.dim('Bundle:')}       ${bundleDir}`);
        console.log(`  ${chalk.dim('Context:')}      ${result.contextPath}`);
        console.log(`  ${chalk.dim('Summary:')}      ${path.join(bundleDir, 'outputs', 'summary.md')}`);
        console.log('');

        // Next steps
        console.log(chalk.dim('Next steps:'));
        console.log(chalk.dim('  • Open .review-assist/CONTEXT.md in your editor and point your agent at it'));
        console.log(chalk.dim('  • Or use a Copilot prompt: /review-threads or /review-quick'));
        if (incremental) {
          console.log(chalk.dim('  • Re-run `review-assist review` any time to pick up new changes'));
          console.log(chalk.dim('  • Use --full to discard session and start a fresh review'));
        } else {
          console.log(chalk.dim('  • Re-run `review-assist review` after new changes for an incremental update'));
        }
      } catch (err) {
        handleError(err);
      }
    });
}
