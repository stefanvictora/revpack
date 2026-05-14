import chalk from 'chalk';
import { loadRuntimeConfig } from '../config/index.js';
import { createProvider } from '../providers/factory.js';
import { ReviewOrchestrator } from '../orchestration/orchestrator.js';
import { GitHelper } from '../workspace/git-helper.js';
import { ReviewAssistError } from '../core/errors.js';

/**
 * Collect git remote URLs from the working directory (best-effort).
 */
async function getRemoteUrls(cwd: string): Promise<string[]> {
  try {
    const git = new GitHelper(cwd);
    return await git.listRemoteUrls();
  } catch {
    return [];
  }
}

/**
 * Create an orchestrator from config. Shared setup for all CLI commands.
 * Resolves the active profile from git remote URLs in the current directory.
 */
export async function createOrchestrator(hintUrls?: string[], explicitProfile?: string): Promise<ReviewOrchestrator> {
  const cwd = process.cwd();
  const remoteUrls = await getRemoteUrls(cwd);
  const config = await loadRuntimeConfig([...remoteUrls, ...(hintUrls ?? [])], explicitProfile);
  const provider = createProvider(config);
  return new ReviewOrchestrator({
    provider,
    workingDir: cwd,
  });
}

/**
 * Create an orchestrator targeting a specific directory (e.g. after clone).
 */
export async function createOrchestratorAt(workingDir: string): Promise<ReviewOrchestrator> {
  const remoteUrls = await getRemoteUrls(workingDir);
  const config = await loadRuntimeConfig(remoteUrls);
  const provider = createProvider(config);
  return new ReviewOrchestrator({
    provider,
    workingDir,
  });
}

/**
 * Standard error handler for CLI commands.
 */
export function handleError(err: unknown): never {
  if (err instanceof ReviewAssistError) {
    console.error(chalk.red(`[${err.code}] ${err.message}`));
  } else if (err instanceof Error) {
    console.error(chalk.red(err.message));
    // Walk the cause chain to surface the root network error
    let cause = (err as NodeJS.ErrnoException).cause;
    while (cause) {
      console.error(chalk.dim(`  caused by: ${cause instanceof Error ? cause.message : JSON.stringify(cause)}`));
      cause = (cause as NodeJS.ErrnoException).cause;
    }
  } else {
    console.error(chalk.red('An unexpected error occurred'));
  }

  if (process.env.DEBUG) {
    console.error(err);
  } else {
    console.error(chalk.dim('  Set DEBUG=1 for full stack trace'));
  }

  process.exit(1);
}

/**
 * Output data as JSON (for --json flag) or return it.
 */
export function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

/**
 * Derive the repository slug (group/project) from git remotes in the cwd.
 * Parses the path from the first remote URL.
 */
export async function getRepoFromGit(): Promise<string | undefined> {
  try {
    const cwd = process.cwd();
    const git = new GitHelper(cwd);
    const urls = await git.listRemoteUrls();
    if (urls.length === 0) return undefined;

    const url = urls[0];
    // SSH: git@host:group/project.git
    const sshMatch = url.match(/:([^/].*?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];

    // HTTPS: https://host/group/project.git
    try {
      const parsed = new URL(url);
      const path = parsed.pathname.replace(/^\//, '').replace(/\.git$/, '');
      return path || undefined;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  }
}
