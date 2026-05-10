import { execFile, spawn as nodeSpawn } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitHelper {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Clone a repository and then check out a specific git refspec into a named local branch.
   * Use this when the source branch may not exist in the remote (e.g. deleted after PR merge)
   * but a permanent refspec is available (e.g. GitHub's `refs/pull/<n>/head`).
   *
   * Steps:
   *   1. Shallow-clone the repository with --no-checkout.
   *   2. Fetch `remoteRef` into `localBranch`.
   *   3. Switch to `localBranch`.
   */
  static async cloneAndCheckoutRef(
    cloneUrl: string,
    remoteRef: string,
    localBranch: string,
    parentDir: string,
    dirName?: string,
  ): Promise<string> {
    const repoName = cloneUrl
      .replace(/\.git$/, '')
      .split('/')
      .pop()!;
    const sanitizedBranch = localBranch.replace(/[/\\:*?"<>|]/g, '-');
    const resolvedName = dirName ?? `${repoName}-${sanitizedBranch}`;

    // Step 1: clone without checking out any branch (avoids downloading default branch content)
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn('git', ['clone', '--depth', '1', '--no-checkout', '--progress', cloneUrl, resolvedName], {
        cwd: parentDir,
        stdio: 'inherit',
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone exited with code ${code}`));
      });
      child.on('error', reject);
    });

    const clonedPath = (await import('node:path')).resolve(parentDir, resolvedName);

    // Step 2: fetch the PR/MR refspec into a local branch
    await exec('git', ['fetch', 'origin', `${remoteRef}:${localBranch}`], { cwd: clonedPath });

    // Step 3: switch to the local branch
    await exec('git', ['switch', localBranch], { cwd: clonedPath });

    return clonedPath;
  }

  /**
   * Creates `<parentDir>/<dirName>` where dirName defaults to `<repoName>-<branch>`.
   * Streams git output to the terminal for progress visibility.
   * Returns the absolute path of the cloned directory.
   */
  static async clone(cloneUrl: string, branch: string, parentDir: string, dirName?: string): Promise<string> {
    // Derive directory name: <repo>-<branch> for easy multi-branch checkout
    const repoName = cloneUrl
      .replace(/\.git$/, '')
      .split('/')
      .pop()!;
    const sanitizedBranch = branch.replace(/[/\\:*?"<>|]/g, '-');
    const resolvedName = dirName ?? `${repoName}-${sanitizedBranch}`;

    const args = ['clone', '--depth', '1', '--branch', branch, '--progress', cloneUrl, resolvedName];

    // Use spawn with inherited stdio so clone progress is shown in terminal,
    // and stdin is inherited so SSH passphrase prompts can be answered interactively.
    await new Promise<void>((resolve, reject) => {
      const child = nodeSpawn('git', args, {
        cwd: parentDir,
        stdio: 'inherit',
      });
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone exited with code ${code}`));
      });
      child.on('error', reject);
    });

    return (await import('node:path')).resolve(parentDir, resolvedName);
  }

  /** Get current branch name. */
  async currentBranch(): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.cwd });
    return stdout.trim();
  }

  /** Get remote URL for origin. */
  async remoteUrl(remote = 'origin'): Promise<string> {
    const { stdout } = await exec('git', ['remote', 'get-url', remote], { cwd: this.cwd });
    return stdout.trim();
  }

  /**
   * List URLs of all configured remotes.
   * Returns an empty array if not inside a git repo or if no remotes are configured.
   */
  async listRemoteUrls(): Promise<string[]> {
    try {
      const { stdout } = await exec('git', ['remote'], { cwd: this.cwd });
      const remoteNames = stdout.trim().split('\n').filter(Boolean);
      const urls: string[] = [];
      for (const name of remoteNames) {
        try {
          const { stdout: url } = await exec('git', ['remote', 'get-url', name], { cwd: this.cwd });
          if (url.trim()) urls.push(url.trim());
        } catch {
          // skip unreachable remotes
        }
      }
      return urls;
    } catch {
      return [];
    }
  }

  /** Derive repo slug (group/project) from a GitLab remote URL. */
  async deriveRepoSlug(remote = 'origin'): Promise<string> {
    const url = await this.remoteUrl(remote);
    // SSH: git@gitlab.example.com:group/project.git
    const sshMatch = url.match(/:([^/].*?)(?:\.git)?$/);
    if (sshMatch) return sshMatch[1];
    // HTTPS: https://gitlab.example.com/group/project.git
    const httpsMatch = url.match(/\/\/[^/]+\/(.+?)(?:\.git)?$/);
    if (httpsMatch) return httpsMatch[1];
    return url;
  }

  /** Fetch a branch from a specific remote URL without adding a named remote. */
  async fetchBranchFromUrl(remoteUrl: string, branch: string): Promise<void> {
    // git fetch <url> <branch>:<branch> — creates a local tracking ref with the same name.
    await exec('git', ['fetch', remoteUrl, `${branch}:${branch}`], { cwd: this.cwd });
  }

  /**
   * Fetch a specific refspec from a remote and create a local branch for it.
   * Example: fetchRef('origin', 'refs/pull/42/head', 'pr-42-head')
   */
  async fetchRef(remote: string, remoteRef: string, localBranch: string): Promise<void> {
    await exec('git', ['fetch', remote, `${remoteRef}:${localBranch}`], { cwd: this.cwd });
  }

  /** Switch to a branch, creating a tracking branch if needed. */
  async switchBranch(branch: string, remote = 'origin'): Promise<void> {
    try {
      // Try switching to existing local branch first
      await exec('git', ['switch', branch], { cwd: this.cwd });
    } catch {
      // Branch doesn't exist locally — create tracking branch from remote
      await exec('git', ['switch', '-c', branch, '--track', `${remote}/${branch}`], { cwd: this.cwd });
    }
  }

  /** Fetch a specific branch from remote. */
  async fetchBranch(branch: string, remote = 'origin'): Promise<void> {
    await exec('git', ['fetch', remote, branch], { cwd: this.cwd });
  }

  /** Check if we're inside a git repository. */
  async isGitRepo(): Promise<boolean> {
    try {
      await exec('git', ['rev-parse', '--git-dir'], { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch latest from remote. */
  async fetch(remote = 'origin'): Promise<void> {
    await exec('git', ['fetch', remote], { cwd: this.cwd });
  }

  /** Read a file at a specific ref. */
  async showFile(ref: string, filePath: string): Promise<string> {
    const { stdout } = await exec('git', ['show', `${ref}:${filePath}`], { cwd: this.cwd });
    return stdout;
  }

  /** Get current HEAD sha. */
  async headSha(): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', 'HEAD'], { cwd: this.cwd });
    return stdout.trim();
  }

  /** Check if a commit is an ancestor of HEAD (i.e. HEAD includes that commit). */
  async isAncestor(commitSha: string): Promise<boolean> {
    try {
      await exec('git', ['merge-base', '--is-ancestor', commitSha, 'HEAD'], { cwd: this.cwd });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if HEAD matches the given commit. */
  async isAtCommit(commitSha: string): Promise<boolean> {
    const head = await this.headSha();
    return head === commitSha;
  }

  /** Check if working tree is clean. */
  async isClean(): Promise<boolean> {
    const { stdout } = await exec('git', ['status', '--porcelain'], { cwd: this.cwd });
    return stdout.trim().length === 0;
  }

  /** Get the repository root directory. */
  async repositoryRoot(): Promise<string> {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd: this.cwd });
    return stdout.trim();
  }

  /** Generate a diff between two refs. */
  async diff(baseRef: string, headRef: string): Promise<string> {
    const { stdout } = await exec('git', ['diff', baseRef, headRef], { cwd: this.cwd });
    return stdout;
  }

  /** List changed files between two refs. */
  async changedFiles(baseRef: string, headRef: string): Promise<string[]> {
    const { stdout } = await exec('git', ['diff', '--name-only', baseRef, headRef], { cwd: this.cwd });
    return stdout.trim().split('\n').filter(Boolean);
  }
}
