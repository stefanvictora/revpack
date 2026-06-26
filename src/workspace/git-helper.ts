import { execFile, spawn as nodeSpawn } from 'node:child_process';

const GIT_LONG_PATHS_CONFIG = ['-c', 'core.longpaths=true'];

function gitArgs(args: string[]): string[] {
  return [...GIT_LONG_PATHS_CONFIG, ...args];
}

async function execGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', gitArgs(args), { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject(error instanceof Error ? error : new Error('Git command failed'));
        return;
      }

      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

function spawnGit(args: string[], cwd: string): ReturnType<typeof nodeSpawn> {
  return nodeSpawn('git', gitArgs(args), {
    cwd,
    stdio: 'inherit',
  });
}

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
      const child = spawnGit(
        ['clone', '--depth', '1', '--no-checkout', '--progress', cloneUrl, resolvedName],
        parentDir,
      );
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git clone exited with code ${code}`));
      });
      child.on('error', reject);
    });

    const clonedPath = (await import('node:path')).resolve(parentDir, resolvedName);

    // Step 2: fetch the PR/MR refspec into a local branch (shallow to match the clone depth)
    await execGit(['fetch', '--depth', '1', 'origin', `${remoteRef}:${localBranch}`], clonedPath);

    // Step 3: switch to the local branch
    await execGit(['switch', localBranch], clonedPath);

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
      const child = spawnGit(args, parentDir);
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
    const { stdout } = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], this.cwd);
    return stdout.trim();
  }

  /** Get remote URL for origin. */
  async remoteUrl(remote = 'origin'): Promise<string> {
    const { stdout } = await execGit(['remote', 'get-url', remote], this.cwd);
    return stdout.trim();
  }

  /**
   * List URLs of all configured remotes.
   * Returns an empty array if not inside a git repo or if no remotes are configured.
   */
  async listRemoteUrls(): Promise<string[]> {
    try {
      const { stdout } = await execGit(['remote'], this.cwd);
      const remoteNames = stdout.trim().split('\n').filter(Boolean);
      const urls: string[] = [];
      for (const name of remoteNames) {
        try {
          const { stdout: url } = await execGit(['remote', 'get-url', name], this.cwd);
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

  /** Resolve a ref to a commit SHA. */
  async revParse(ref: string): Promise<string> {
    const { stdout } = await execGit(['rev-parse', '--verify', `${ref}^{commit}`], this.cwd);
    return stdout.trim();
  }

  /** Check whether a ref resolves to a commit. */
  async refExists(ref: string): Promise<boolean> {
    try {
      await this.revParse(ref);
      return true;
    } catch {
      return false;
    }
  }

  /** Return the merge-base between two refs. */
  async mergeBase(leftRef: string, rightRef: string): Promise<string> {
    const { stdout } = await execGit(['merge-base', leftRef, rightRef], this.cwd);
    return stdout.trim();
  }

  /** Read a git config value, returning undefined when it is not configured. */
  async configValue(key: string): Promise<string | undefined> {
    try {
      const { stdout } = await execGit(['config', '--get', key], this.cwd);
      const value = stdout.trim();
      return value || undefined;
    } catch {
      return undefined;
    }
  }

  /** Fetch a branch from a specific remote URL without adding a named remote. */
  async fetchBranchFromUrl(remoteUrl: string, branch: string): Promise<void> {
    // git fetch <url> <branch>:<branch> — creates a local tracking ref with the same name.
    await execGit(['fetch', remoteUrl, `${branch}:${branch}`], this.cwd);
  }

  /**
   * Fetch a specific refspec from a remote and create a local branch for it.
   * Uses --depth 1 to keep the fetch shallow.
   * Example: fetchRef('origin', 'refs/pull/42/head', 'pr-42-head')
   */
  async fetchRef(remote: string, remoteRef: string, localBranch: string): Promise<void> {
    await execGit(['fetch', '--depth', '1', remote, `${remoteRef}:${localBranch}`], this.cwd);
  }

  /** Switch to a branch, creating a tracking branch if needed. */
  async switchBranch(branch: string, remote = 'origin'): Promise<void> {
    try {
      // Try switching to existing local branch first
      await execGit(['switch', branch], this.cwd);
    } catch {
      // Branch doesn't exist locally — create tracking branch from remote
      await execGit(['switch', '-c', branch, '--track', `${remote}/${branch}`], this.cwd);
    }
  }

  /** Fetch a specific branch from remote. */
  async fetchBranch(
    branch: string,
    remote = 'origin',
    options?: { depth?: number; noTags?: boolean; progress?: boolean },
  ): Promise<void> {
    const args = this.buildFetchArgs(remote, branch, options);
    if (options?.progress) {
      await this.runGitWithInheritedOutput(this.buildFetchArgs(remote, branch, options, true));
      return;
    }

    await execGit(args, this.cwd);
  }

  /** Check if we're inside a git repository. */
  async isGitRepo(): Promise<boolean> {
    try {
      await execGit(['rev-parse', '--git-dir'], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Fetch latest from remote. */
  async fetch(remote = 'origin', options?: { depth?: number; noTags?: boolean; progress?: boolean }): Promise<void> {
    const args = this.buildFetchArgs(remote, undefined, options);
    if (options?.progress) {
      await this.runGitWithInheritedOutput(this.buildFetchArgs(remote, undefined, options, true));
      return;
    }

    await execGit(args, this.cwd);
  }

  /** Fetch a specific commit/object from a remote into FETCH_HEAD when the server allows it. */
  async fetchCommit(
    commitSha: string,
    remote = 'origin',
    options?: { depth?: number; noTags?: boolean; progress?: boolean },
  ): Promise<void> {
    const args = this.buildFetchArgs(remote, commitSha, options);
    if (options?.progress) {
      await this.runGitWithInheritedOutput(this.buildFetchArgs(remote, commitSha, options, true));
      return;
    }

    await execGit(args, this.cwd);
  }

  /** Read a file at a specific ref. */
  async showFile(ref: string, filePath: string): Promise<string> {
    const { stdout } = await execGit(['show', `${ref}:${filePath}`], this.cwd);
    return stdout;
  }

  /** Get current HEAD sha. */
  async headSha(): Promise<string> {
    const { stdout } = await execGit(['rev-parse', 'HEAD'], this.cwd);
    return stdout.trim();
  }

  /** Check if `ancestorSha` is an ancestor of `descendantRef`. */
  async isAncestor(ancestorSha: string, descendantRef = 'HEAD'): Promise<boolean> {
    try {
      await execGit(['merge-base', '--is-ancestor', ancestorSha, descendantRef], this.cwd);
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

  /** Check whether a commit object exists locally. */
  async hasCommit(commitSha: string): Promise<boolean> {
    try {
      await execGit(['cat-file', '-e', `${commitSha}^{commit}`], this.cwd);
      return true;
    } catch {
      return false;
    }
  }

  /** Get the repository root directory. */
  async repositoryRoot(): Promise<string> {
    const { stdout } = await execGit(['rev-parse', '--show-toplevel'], this.cwd);
    return stdout.trim();
  }

  /** Generate a diff between two refs. */
  async diff(baseRef: string, headRef: string): Promise<string> {
    const { stdout } = await execGit(['diff', baseRef, headRef], this.cwd);
    return stdout;
  }

  /** Generate the canonical review patch between two commits. */
  async diffForReview(baseSha: string, headSha: string): Promise<string> {
    const { stdout } = await execGit(
      ['diff', '--find-renames', '--unified=3', '--ignore-space-at-eol', '--ignore-blank-lines', baseSha, headSha],
      this.cwd,
    );
    return stdout;
  }

  /** List changed files between two refs. */
  async changedFiles(baseRef: string, headRef: string): Promise<string[]> {
    const { stdout } = await execGit(['diff', '--name-only', baseRef, headRef], this.cwd);
    return stdout.trim().split('\n').filter(Boolean);
  }

  private async runGitWithInheritedOutput(args: string[]): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawnGit(args, this.cwd);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`git ${args.join(' ')} exited with code ${code}`));
      });
      child.on('error', reject);
    });
  }

  private buildFetchArgs(
    remote: string,
    ref?: string,
    options?: { depth?: number; noTags?: boolean },
    progress = false,
  ): string[] {
    return [
      'fetch',
      ...(progress ? ['--progress'] : []),
      ...(options?.noTags ? ['--no-tags'] : []),
      ...(options?.depth ? [`--depth=${options.depth}`] : []),
      remote,
      ...(ref ? [ref] : []),
    ];
  }
}
