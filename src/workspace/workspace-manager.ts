import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ReviewTarget,
  ReviewThread,
  ReviewDiff,
  ReviewVersion,
  WorkspaceBundle,
  FileExcerpt,
  BundleInstructions,
  Session,
} from '../core/types.js';
import { WorkspaceError } from '../core/errors.js';

export class WorkspaceManager {
  private readonly baseDir: string;

  constructor(workingDir: string, bundleDirName = '.review-assist') {
    this.baseDir = path.join(workingDir, bundleDirName);
  }

  get bundlePath(): string {
    return this.baseDir;
  }

  // ─── Bundle creation ────────────────────────────────────

  async createBundle(
    target: ReviewTarget,
    threads: ReviewThread[],
    diffs: ReviewDiff[],
    versions: ReviewVersion[],
    repoDir: string,
  ): Promise<WorkspaceBundle> {
    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();

    // Create directory structure
    await this.ensureDir(this.baseDir);
    await this.ensureDir(path.join(this.baseDir, 'threads'));
    await this.ensureDir(path.join(this.baseDir, 'diffs'));
    await this.ensureDir(path.join(this.baseDir, 'files'));
    await this.ensureDir(path.join(this.baseDir, 'instructions'));
    await this.ensureDir(path.join(this.baseDir, 'outputs'));

    // Collect file excerpts from thread positions
    const fileExcerpts = await this.collectFileExcerpts(threads, repoDir);

    // Load instructions from repo if present
    const instructions = await this.loadInstructions(repoDir);

    const bundle: WorkspaceBundle = {
      sessionId,
      createdAt,
      target,
      threads,
      diffs,
      versions,
      fileExcerpts,
      instructions,
      outputDir: path.join(this.baseDir, 'outputs'),
    };

    // Write bundle files
    await this.writeSession({ id: sessionId, createdAt, targetRef: target, bundlePath: this.baseDir });
    await this.writeTarget(target);
    await this.writeThreads(threads);
    await this.writeDiffs(diffs);
    await this.writeFileExcerpts(fileExcerpts);
    await this.writeInstructions(instructions);

    return bundle;
  }

  // ─── Session management ─────────────────────────────────

  async loadSession(): Promise<Session | null> {
    const sessionPath = path.join(this.baseDir, 'session.json');
    try {
      const data = await fs.readFile(sessionPath, 'utf-8');
      return JSON.parse(data) as Session;
    } catch {
      return null;
    }
  }

  async saveSession(session: Session): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'session.json'), session);
  }

  // ─── Output helpers ─────────────────────────────────────

  async writeOutput(filename: string, content: string): Promise<string> {
    const outputPath = path.join(this.baseDir, 'outputs', filename);
    await fs.writeFile(outputPath, content, 'utf-8');
    return outputPath;
  }

  async readOutput(filename: string): Promise<string> {
    const outputPath = path.join(this.baseDir, 'outputs', filename);
    return fs.readFile(outputPath, 'utf-8');
  }

  // ─── Internal helpers ───────────────────────────────────

  private async writeSession(session: Session): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'session.json'), session);
  }

  private async writeTarget(target: ReviewTarget): Promise<void> {
    await this.writeJson(path.join(this.baseDir, 'target.json'), target);
  }

  private async writeThreads(threads: ReviewThread[]): Promise<void> {
    for (let i = 0; i < threads.length; i++) {
      const thread = threads[i];
      const prefix = `T-${String(i + 1).padStart(3, '0')}`;

      // JSON version
      await this.writeJson(path.join(this.baseDir, 'threads', `${prefix}.json`), thread);

      // Markdown version for human/agent reading
      const md = this.threadToMarkdown(thread, prefix);
      await fs.writeFile(path.join(this.baseDir, 'threads', `${prefix}.md`), md, 'utf-8');
    }
  }

  private async writeDiffs(diffs: ReviewDiff[]): Promise<void> {
    const patchContent = diffs.map((d) => {
      const header = `diff --git a/${d.oldPath} b/${d.newPath}`;
      return `${header}\n${d.diff}`;
    }).join('\n');

    await fs.writeFile(path.join(this.baseDir, 'diffs', 'latest.patch'), patchContent, 'utf-8');
  }

  private async writeFileExcerpts(excerpts: FileExcerpt[]): Promise<void> {
    for (const excerpt of excerpts) {
      const safeName = excerpt.filePath.replace(/[/\\]/g, '_').replace(/[^a-zA-Z0-9_.-]/g, '_');
      const filename = `${safeName}_L${excerpt.startLine}-L${excerpt.endLine}.txt`;
      await fs.writeFile(
        path.join(this.baseDir, 'files', filename),
        `// ${excerpt.filePath}:${excerpt.startLine}-${excerpt.endLine}\n${excerpt.content}`,
        'utf-8',
      );
    }
  }

  private async writeInstructions(instructions: BundleInstructions): Promise<void> {
    if (instructions.claudeMd) {
      await fs.writeFile(
        path.join(this.baseDir, 'instructions', 'CLAUDE.md'),
        instructions.claudeMd,
        'utf-8',
      );
    }
    if (instructions.reviewMd) {
      await fs.writeFile(
        path.join(this.baseDir, 'instructions', 'REVIEW.md'),
        instructions.reviewMd,
        'utf-8',
      );
    }
    if (instructions.projectRules) {
      await fs.writeFile(
        path.join(this.baseDir, 'instructions', 'project-review-rules.md'),
        instructions.projectRules,
        'utf-8',
      );
    }
  }

  private async collectFileExcerpts(
    threads: ReviewThread[],
    repoDir: string,
  ): Promise<FileExcerpt[]> {
    const excerpts: FileExcerpt[] = [];
    const seen = new Set<string>();

    for (const thread of threads) {
      if (!thread.position?.filePath) continue;
      const { filePath, newLine } = thread.position;
      const line = newLine ?? 1;
      const contextLines = 30;
      const startLine = Math.max(1, line - contextLines);
      const endLine = line + contextLines;
      const key = `${filePath}:${startLine}-${endLine}`;

      if (seen.has(key)) continue;
      seen.add(key);

      try {
        const fullPath = path.join(repoDir, filePath);
        const content = await fs.readFile(fullPath, 'utf-8');
        const lines = content.split('\n');
        const excerpt = lines.slice(startLine - 1, endLine).join('\n');
        excerpts.push({ filePath, startLine, endLine: Math.min(endLine, lines.length), content: excerpt });
      } catch {
        // File may not exist in working tree (deleted file, etc.)
      }
    }

    return excerpts;
  }

  private async loadInstructions(repoDir: string): Promise<BundleInstructions> {
    const instructions: BundleInstructions = {};

    const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
    const reviewMdPath = path.join(repoDir, 'REVIEW.md');
    const rulesPath = path.join(repoDir, '.review-assist', 'rules.md');

    try { instructions.claudeMd = await fs.readFile(claudeMdPath, 'utf-8'); } catch { /* not present */ }
    try { instructions.reviewMd = await fs.readFile(reviewMdPath, 'utf-8'); } catch { /* not present */ }
    try { instructions.projectRules = await fs.readFile(rulesPath, 'utf-8'); } catch { /* not present */ }

    return instructions;
  }

  private threadToMarkdown(thread: ReviewThread, prefix: string): string {
    const lines: string[] = [];
    lines.push(`# ${prefix}: Thread ${thread.threadId}`);
    lines.push('');
    lines.push(`- **Status**: ${thread.resolved ? 'Resolved' : 'Unresolved'}`);
    lines.push(`- **Resolvable**: ${thread.resolvable}`);
    if (thread.position) {
      lines.push(`- **File**: \`${thread.position.filePath}\``);
      if (thread.position.newLine) lines.push(`- **Line**: ${thread.position.newLine}`);
    }
    lines.push('');
    lines.push('## Comments');
    lines.push('');
    for (const comment of thread.comments) {
      if (comment.system) continue;
      lines.push(`### ${comment.author} (${comment.origin}) — ${comment.createdAt}`);
      lines.push('');
      lines.push(comment.body);
      lines.push('');
      lines.push('---');
      lines.push('');
    }
    return lines.join('\n');
  }

  private async ensureDir(dir: string): Promise<void> {
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new WorkspaceError(`Failed to create directory ${dir}: ${err}`);
    }
  }

  private async writeJson(filePath: string, data: unknown): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
