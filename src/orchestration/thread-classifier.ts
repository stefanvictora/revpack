import type { ReviewThread, Severity, Confidence, CommentOrigin } from '../core/types.js';

export interface ThreadClassification {
  threadId: string;
  severity: Severity;
  confidence: Confidence;
  category: string;
  origin: CommentOrigin;
  summary: string;
}

/**
 * Heuristic thread classifier. Categorizes threads by severity,
 * type, and origin without requiring an LLM.
 */
export class ThreadClassifier {
  classify(thread: ReviewThread): ThreadClassification {
    const firstComment = thread.comments.find((c) => !c.system);
    if (!firstComment) {
      return {
        threadId: thread.threadId,
        severity: 'info',
        confidence: 'low',
        category: 'other',
        origin: 'unknown',
        summary: 'Empty or system-only thread',
      };
    }

    const body = firstComment.body.toLowerCase();
    const origin = firstComment.origin;

    return {
      threadId: thread.threadId,
      severity: this.detectSeverity(body),
      confidence: this.detectConfidence(body),
      category: this.detectCategory(body),
      origin,
      summary: this.extractSummary(firstComment.body),
    };
  }

  private detectSeverity(body: string): Severity {
    if (this.matches(body, ['blocker', 'critical', 'security', 'vulnerability', 'injection', 'xss'])) return 'blocker';
    if (this.matches(body, ['bug', 'error', 'wrong', 'incorrect', 'break', 'crash', 'race condition'])) return 'high';
    if (this.matches(body, ['should', 'consider', 'potential', 'might', 'could cause'])) return 'medium';
    if (this.matches(body, ['nit', 'nitpick', 'minor', 'style', 'formatting', 'typo'])) return 'nit';
    if (this.matches(body, ['question', 'why', 'curious', 'wondering', 'fyi', 'note'])) return 'info';
    return 'low';
  }

  private detectConfidence(body: string): Confidence {
    // Bot-generated comments often have structured formatting
    if (this.matches(body, ['suggestion', '```suggestion', '```diff'])) return 'high';
    if (this.matches(body, ['i think', 'maybe', 'not sure', 'might be', 'could be'])) return 'low';
    return 'medium';
  }

  private detectCategory(body: string): string {
    if (this.matches(body, ['security', 'vulnerability', 'injection', 'xss', 'csrf', 'auth'])) return 'security';
    if (this.matches(body, ['performance', 'slow', 'n+1', 'memory', 'leak', 'cache'])) return 'performance';
    if (this.matches(body, ['test', 'coverage', 'assertion', 'mock', 'spec'])) return 'testing';
    if (this.matches(body, ['type', 'typescript', 'interface', 'generic', 'cast'])) return 'type-safety';
    if (this.matches(body, ['null', 'undefined', 'guard', 'check', 'validation'])) return 'correctness';
    if (this.matches(body, ['name', 'naming', 'rename', 'readability', 'clarity'])) return 'naming';
    if (this.matches(body, ['style', 'format', 'lint', 'whitespace', 'indent'])) return 'style';
    if (this.matches(body, ['doc', 'comment', 'jsdoc', 'readme', 'documentation'])) return 'documentation';
    if (this.matches(body, ['architecture', 'design', 'pattern', 'refactor', 'abstraction'])) return 'architecture';
    if (this.matches(body, ['error', 'exception', 'handle', 'catch', 'throw'])) return 'error-handling';
    return 'general';
  }

  private extractSummary(body: string): string {
    // Take first meaningful line, truncated
    const firstLine = body.split('\n').find((l) => l.trim().length > 0) ?? '';
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '...' : firstLine;
  }

  private matches(text: string, keywords: string[]): boolean {
    return keywords.some((kw) => text.includes(kw));
  }
}
