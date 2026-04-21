import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

const MARKER_START = '<!-- review-assist:start -->';
const MARKER_END = '<!-- review-assist:end -->';

export function registerUpdateDescriptionCommand(program: Command): void {
  program
    .command('update-description [ref]')
    .description('Append or update a review-assist section in the MR/PR description')
    .option('--repo <repo>', 'Repository slug (group/project)')
    .option('--from <file>', 'Read content from a file')
    .option('--from-summary', 'Use the generated summary.md from the workspace bundle')
    .option('--replace', 'Replace the entire description instead of updating the marked section')
    .action(async (ref: string | undefined, opts: { repo?: string; from?: string; fromSummary?: boolean; replace?: boolean }) => {
      try {
        let content: string;
        if (opts.from) {
          content = await fs.readFile(opts.from, 'utf-8');
        } else if (opts.fromSummary) {
          try {
            content = await fs.readFile('.review-assist/outputs/summary.md', 'utf-8');
          } catch {
            console.error(chalk.red('No summary found. Run `review-assist review` first.'));
            process.exit(1);
          }
        } else {
          console.error(chalk.red('Provide --from <file> or --from-summary'));
          process.exit(1);
        }

        const orchestrator = await createOrchestrator();
        const defaultRepo = opts.repo ?? await getDefaultRepo();

        let body: string;
        if (opts.replace) {
          body = content;
        } else {
          // Fetch current description and merge with markers
          const target = await orchestrator.open(ref, defaultRepo);
          body = mergeWithMarkers(target.description, content);
        }

        await orchestrator.updateDescription(ref, body, defaultRepo);
        console.log(chalk.green(`✓ Description updated${ref ? ` for ${ref}` : ''}${opts.replace ? '' : ' (marked section)'}`));
      } catch (err) {
        handleError(err);
      }
    });
}

/**
 * Merge new content into the description using HTML comment markers.
 * If markers exist, replaces the content between them.
 * If no markers exist, appends a new marked section.
 */
function mergeWithMarkers(existing: string, newContent: string): string {
  const markedSection = `${MARKER_START}\n${newContent.trim()}\n${MARKER_END}`;

  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);

  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing marked section
    return existing.slice(0, startIdx) + markedSection + existing.slice(endIdx + MARKER_END.length);
  }

  // Append new section
  const separator = existing.trim() ? '\n\n---\n\n' : '';
  return existing.trimEnd() + separator + markedSection;
}
