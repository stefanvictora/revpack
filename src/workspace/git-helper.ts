import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export class GitHelper {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  /**
   * Shallow-clone a repository into a new directory.
   * Creates `<parentDir>/<dirName>` (like `git clone` derives from the URL).
   * Returns the absolute path of the cloned directory.
   */
  static async clone(
    cloneUrl: string,
    branch: string,
    parentDir: string,
    dirName?: string,
  ): Promise<string> {
    const args = ['clone', '--depth', '1', '--branch', branch, cloneUrl];
    if (dirName) args.push(dirName);
    await exec('git', args, { cwd: parentDir });

    // Determine the actual directory name (git uses the repo name from the URL)
    const resolvedName = dirName ?? cloneUrl.replace(/\.git$/, '').split('/').pop()!;
    const { resolve } = await import('node:path');
    return resolve(parentDir, resolvedName);
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

  /** Checkout a branch or ref. */
  async checkout(ref: string): Promise<void> {
    await exec('git', ['checkout', ref], { cwd: this.cwd });
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
