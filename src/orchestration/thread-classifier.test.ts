import { describe, it, expect } from 'vitest';
import { ThreadClassifier } from '../orchestration/thread-classifier.js';
import type { ReviewThread } from '../core/types.js';

function makeThread(body: string, opts?: Partial<ReviewThread>): ReviewThread {
  return {
    provider: 'gitlab',
    targetRef: {
      provider: 'gitlab',
      repository: 'group/project',
      targetType: 'merge_request',
      targetId: '1',
    },
    threadId: 'thread-1',
    resolved: false,
    resolvable: true,
    comments: [
      {
        id: 'note-1',
        body,
        author: 'reviewer',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        origin: 'human',
        system: false,
      },
    ],
    ...opts,
  };
}

describe('ThreadClassifier', () => {
  const classifier = new ThreadClassifier();

  describe('severity detection', () => {
    it('detects blocker severity for security keywords', () => {
      const result = classifier.classify(makeThread('This has a SQL injection vulnerability'));
      expect(result.severity).toBe('blocker');
    });

    it('detects high severity for bug keywords', () => {
      const result = classifier.classify(makeThread('This is a bug — the function returns the wrong value'));
      expect(result.severity).toBe('high');
    });

    it('detects medium severity for suggestion keywords', () => {
      const result = classifier.classify(makeThread('You should consider using a map here'));
      expect(result.severity).toBe('medium');
    });

    it('detects nit severity for style comments', () => {
      const result = classifier.classify(makeThread('nit: extra whitespace'));
      expect(result.severity).toBe('nit');
    });

    it('detects info severity for questions', () => {
      const result = classifier.classify(makeThread('Why did you choose this approach?'));
      expect(result.severity).toBe('info');
    });

    it('defaults to low severity for unmatched text', () => {
      const result = classifier.classify(makeThread('Something about this line'));
      expect(result.severity).toBe('low');
    });
  });

  describe('category detection', () => {
    it('detects security category', () => {
      const result = classifier.classify(makeThread('There is a CSRF vulnerability here'));
      expect(result.category).toBe('security');
    });

    it('detects performance category', () => {
      const result = classifier.classify(makeThread('This query causes an N+1 problem'));
      expect(result.category).toBe('performance');
    });

    it('detects testing category', () => {
      const result = classifier.classify(makeThread('Missing test coverage for this branch'));
      expect(result.category).toBe('testing');
    });

    it('detects correctness category', () => {
      const result = classifier.classify(makeThread('Missing null guard on user input'));
      expect(result.category).toBe('correctness');
    });

    it('detects style category', () => {
      const result = classifier.classify(makeThread('Formatting lint issue on this line'));
      expect(result.category).toBe('style');
    });

    it('detects architecture category', () => {
      const result = classifier.classify(makeThread('This design pattern is not ideal'));
      expect(result.category).toBe('architecture');
    });

    it('defaults to general', () => {
      const result = classifier.classify(makeThread('Looks good to me'));
      expect(result.category).toBe('general');
    });
  });

  describe('confidence detection', () => {
    it('high confidence for suggestion blocks', () => {
      const result = classifier.classify(makeThread('```suggestion\nfoo()\n```'));
      expect(result.confidence).toBe('high');
    });

    it('low confidence for hedging language', () => {
      const result = classifier.classify(makeThread('I think maybe this could be wrong'));
      expect(result.confidence).toBe('low');
    });

    it('medium confidence by default', () => {
      const result = classifier.classify(makeThread('Please fix this'));
      expect(result.confidence).toBe('medium');
    });
  });

  describe('summary extraction', () => {
    it('extracts first line as summary', () => {
      const result = classifier.classify(makeThread('First line\nSecond line\nThird line'));
      expect(result.summary).toBe('First line');
    });

    it('truncates long first lines', () => {
      const longLine = 'A'.repeat(200);
      const result = classifier.classify(makeThread(longLine));
      expect(result.summary.length).toBeLessThanOrEqual(120);
      expect(result.summary).toContain('...');
    });
  });

  describe('edge cases', () => {
    it('handles thread with only system comments', () => {
      const thread = makeThread('');
      thread.comments = [
        { id: 'n1', body: 'changed the title', author: 'system', createdAt: '', updatedAt: '', origin: 'bot', system: true },
      ];
      const result = classifier.classify(thread);
      expect(result.severity).toBe('info');
      expect(result.summary).toBe('Empty or system-only thread');
    });
  });
});
