import type { Command } from 'commander';
import * as fs from 'node:fs/promises';
import chalk from 'chalk';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { createOrchestrator, getDefaultRepo, handleError } from '../helpers.js';

const DEFAULT_REPLIES_FILE = '.review-assist/outputs/replies.json';

interface ReplyEntry {
  threadId: string; // T-001 shorthand or full SHA
  body: string;
  resolve?: boolean;
}

async function loadRepliesJson(filePath: string): Promise<ReplyEntry[]> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf-8');
  } catch {
    throw new Error(`Cannot read ${filePath} — run 'review-assist review' first to generate it`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('expected array');
    return parsed as ReplyEntry[];
  } catch {
    throw new Error(`${filePath} must be a JSON array of { threadId, body, resolve? } objects`);
  }
}

async function saveRepliesJson(filePath: string, entries: ReplyEntry[]): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(entries, null, 2), 'utf-8');
}

export function registerPublishReplyCommand(program: Command): void {
  program
    .command('publish-reply [thread]')
    .description([
      'Publish replies to review threads.',
      '  No argument: publish all replies from replies.json',
      '  [thread]:   publish one thread (T-001 or full SHA)',
      '  Published entries are removed from the file.',
    ].join('\n'))
    .option('--from <file>', `Replies JSON file (default: ${DEFAULT_REPLIES_FILE})`)
    .option('--body <text>', 'Inline reply body (single thread only)')
    .option('--resolve', 'Resolve the thread(s) after replying')
    .action(async (thread: string | undefined, opts: { from?: string; body?: string; resolve?: boolean }) => {
      try {
        const orchestrator = await createOrchestrator();
        const defaultRepo = await getDefaultRepo();
        const repliesFile = opts.from ?? DEFAULT_REPLIES_FILE;

        if (thread) {
          // ── Single thread ──────────────────────────────────────────────────
          let body: string;
          let shouldResolve = opts.resolve ?? false;
          let entries: ReplyEntry[] | undefined;
          let matchedIdx = -1;

          if (opts.body) {
            body = opts.body;
          } else {
            // Look up this thread in the replies file
            entries = await loadRepliesJson(repliesFile);
            const resolved = await orchestrator.resolveThreadRef(thread);
            matchedIdx = entries.findIndex(
              (e) => e.threadId === thread || e.threadId === resolved,
            );
            if (matchedIdx === -1) {
              console.error(chalk.red(`No reply found for "${thread}" in ${repliesFile}`));
              console.error(chalk.dim('Available: ' + entries.map((e) => e.threadId).join(', ')));
              process.exit(1);
            }
            body = entries[matchedIdx].body;
            shouldResolve = opts.resolve ?? entries[matchedIdx].resolve ?? false;
          }

          await orchestrator.publishReply(undefined, thread, body, defaultRepo);
          console.log(chalk.green(`✓ Replied to ${thread}`));
          if (shouldResolve) {
            await orchestrator.resolveThread(undefined, thread, defaultRepo);
            console.log(chalk.dim('  thread resolved'));
          }

          // Remove published entry and record in session
          const ws = new WorkspaceManager(process.cwd());
          if (entries && matchedIdx >= 0) {
            entries.splice(matchedIdx, 1);
            await saveRepliesJson(repliesFile, entries);
          }
          await ws.appendPublishedAction({
            type: 'reply',
            threadId: thread,
            detail: body.split('\n')[0].slice(0, 80),
            publishedAt: new Date().toISOString(),
          });
          if (shouldResolve) {
            await ws.appendPublishedAction({
              type: 'resolve',
              threadId: thread,
              detail: 'Thread resolved',
              publishedAt: new Date().toISOString(),
            });
          }

        } else {
          // ── All threads ────────────────────────────────────────────────────
          const entries = await loadRepliesJson(repliesFile);
          if (entries.length === 0) {
            console.log(chalk.dim('No replies to publish.'));
            return;
          }

          let posted = 0;
          let resolved = 0;
          const ws = new WorkspaceManager(process.cwd());
          const remaining: ReplyEntry[] = [];
          for (const entry of entries) {
            try {
              await orchestrator.publishReply(undefined, entry.threadId, entry.body, defaultRepo);
              console.log(chalk.green(`  ✓ ${entry.threadId}`));
              posted++;
              await ws.appendPublishedAction({
                type: 'reply',
                threadId: entry.threadId,
                detail: entry.body.split('\n')[0].slice(0, 80),
                publishedAt: new Date().toISOString(),
              });
              if (entry.resolve || opts.resolve) {
                await orchestrator.resolveThread(undefined, entry.threadId, defaultRepo);
                console.log(chalk.dim('    resolved'));
                resolved++;
                await ws.appendPublishedAction({
                  type: 'resolve',
                  threadId: entry.threadId,
                  detail: 'Thread resolved',
                  publishedAt: new Date().toISOString(),
                });
              }
            } catch (err) {
              console.error(chalk.red(`  ✗ ${entry.threadId}: ${err instanceof Error ? err.message : String(err)}`));
              remaining.push(entry); // keep failed entries
            }
          }

          // Remove published entries, keep only failed ones
          await saveRepliesJson(repliesFile, remaining);

          console.log('');
          console.log(chalk.green(`Done: ${posted} replied, ${resolved} resolved`));
        }
      } catch (err) {
        handleError(err);
      }
    });
}

