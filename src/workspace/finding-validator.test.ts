import { describe, it, expect } from 'vitest';
import { validateFindings, formatValidationErrors } from './finding-validator.js';
import type { LineMap } from './patch-parser.js';

const makeLineMap = (): LineMap => ({
  files: [
    {
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      status: 'modified',
      lines: [
        { type: 'context', oldLine: 1, newLine: 1, text: 'class App {' },
        { type: 'added', newLine: 2, text: '    private String name;' },
        { type: 'removed', oldLine: 2, text: '    private int age;' },
        { type: 'context', oldLine: 3, newLine: 3, text: '}' },
        { type: 'context', oldLine: 10, newLine: 10, text: '    validate(user);' },
        { type: 'added', newLine: 11, text: '    audit.log(user);' },
        { type: 'context', oldLine: 11, newLine: 12, text: '    notify(user);' },
      ],
      binary: false,
      oldExists: true,
      newExists: true,
    },
    {
      oldPath: 'src/RenamedOld.java',
      newPath: 'src/RenamedNew.java',
      status: 'renamed',
      lines: [{ type: 'added', newLine: 5, text: '    renamed();' }],
      binary: false,
      oldExists: true,
      newExists: true,
    },
  ],
});

describe('validateFindings', () => {
  describe('valid findings', () => {
    it('accepts a valid added-line finding', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Test finding',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(0);
      expect(result.valid).toHaveLength(1);
    });

    it('accepts a valid removed-line finding', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 2,
          body: 'Removed something important',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(0);
      expect(result.valid).toHaveLength(1);
    });

    it('accepts a valid context-line finding', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 11,
          newLine: 12,
          body: 'Context finding',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(0);
      expect(result.valid).toHaveLength(1);
    });

    it('accepts an empty array', () => {
      const result = validateFindings([], makeLineMap());
      expect(result.errors).toHaveLength(0);
      expect(result.valid).toHaveLength(0);
    });

    it('keeps valid findings when another finding fails positional validation', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Valid finding',
          severity: 'high',
          category: 'correctness',
        },
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 99,
          body: 'Invalid finding',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.valid).toEqual([findings[0]]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(1);
    });
  });

  describe('invalid findings', () => {
    it('rejects newLine-only finding on a context line', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 12,
          body: 'Should fail',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('context line');
      expect(result.errors[0].message).toContain('both oldLine and newLine');
      expect(result.errors[0].message).toContain(
        'newLine=12 in src/App.java is a context line (oldLine=11, newLine=12).',
      );
      expect(result.errors[0].message).toBe(
        'newLine-only findings must point to an added line. newLine=12 in src/App.java is a context line (oldLine=11, newLine=12). Context lines require both oldLine and newLine.',
      );
    });

    it('rejects finding with line outside the diff', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 99,
          body: 'Line not in diff',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No valid added-line anchor');
      expect(result.errors[0].message).toContain('newLine 99');
      expect(result.errors[0].message).toContain(
        'If this line is outside the visible diff, move the issue to note.md or anchor it to the closest visible changed/context line.',
      );
      expect(result.errors[0].message).toBe(
        'No valid added-line anchor found for src/App.java newLine 99. If this is an unchanged context line, provide both oldLine and newLine. If this line is outside the visible diff, move the issue to note.md or anchor it to the closest visible changed/context line.',
      );
    });

    it('rejects finding for non-existent file', () => {
      const findings = [
        {
          oldPath: 'src/Missing.java',
          newPath: 'src/Missing.java',
          newLine: 1,
          body: 'File not found',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No file entry found');
      expect(result.errors[0].message).toBe(
        'No file entry found in diffs/latest.patch for oldPath="src/Missing.java", newPath="src/Missing.java". The finding must reference a file that exists in the MR diff.',
      );
    });

    it('requires both oldPath and newPath to match the same file entry', () => {
      const findings = [
        {
          oldPath: 'src/RenamedOld.java',
          newPath: 'src/App.java',
          newLine: 5,
          body: 'Wrong side of rename',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('oldPath="src/RenamedOld.java", newPath="src/App.java"');
    });

    it('rejects invalid severity', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Bad severity',
          severity: 'major',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Schema error');
      expect(result.errors[0].index).toBe(0);
      expect(result.errors[0].finding).toEqual(findings[0]);
      expect(result.errors[0].message).toContain('(at 0.severity)');
    });

    it('reports root-level schema errors at index zero', () => {
      const result = validateFindings({ not: 'an array' } as unknown as unknown[], makeLineMap());

      expect(result.valid).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(0);
      expect(result.errors[0].finding).toEqual({});
      expect(result.errors[0].message).toContain('Schema error');
      expect(result.errors[0].message).toContain('(at )');
    });

    it('accepts custom non-empty categories', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Custom category',
          severity: 'high',
          category: 'bug',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(0);
      expect(result.valid).toEqual(findings);
    });

    it('rejects empty category', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Empty category',
          severity: 'high',
          category: '',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Schema error');
      expect(result.errors[0].message).toContain('(at 0.category)');
    });

    it('reports schema errors at the failing finding index', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Valid finding',
          severity: 'high',
          category: 'correctness',
        },
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Bad severity',
          severity: 'major',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.valid).toEqual([]);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].index).toBe(1);
      expect(result.errors[0].finding).toEqual(findings[1]);
      expect(result.errors[0].message).toContain('(at 1.severity)');
    });

    it('rejects finding missing both line fields', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          body: 'No line',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Schema error');
    });

    it('rejects context-line finding with wrong old/new combination', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 10,
          newLine: 11,
          body: 'Wrong context',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No valid context-line anchor');
      expect(result.errors[0].message).toContain('oldLine=10, newLine=11');
      expect(result.errors[0].message).toContain('Context lines require both oldLine and newLine to match exactly.');
    });

    it('rejects oldLine-only finding on a line that is not removed', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 99,
          body: 'Not a removed line',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No valid removed-line anchor');
      expect(result.errors[0].message).toContain(
        'If this line is outside the visible diff, move the issue to note.md or anchor it to the closest visible changed/context line.',
      );
    });

    it('rejects oldLine-only finding on a context line', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 10,
          body: 'Context is not removed',
          severity: 'high',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No valid removed-line anchor');
      expect(result.errors[0].message).toContain('oldLine 10');
    });

    it('rejects context-line finding when the line type is added', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          oldLine: 2,
          newLine: 2,
          body: 'Added is not context',
          severity: 'medium',
          category: 'correctness',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('No valid context-line anchor');
      expect(result.errors[0].message).toContain('oldLine=2, newLine=2');
    });
  });

  describe('formatValidationErrors', () => {
    it('formats errors with full location details', () => {
      const result = validateFindings(
        [
          {
            oldPath: 'src/App.java',
            newPath: 'src/App.java',
            newLine: 99,
            body: 'Not in diff',
            severity: 'high',
            category: 'correctness',
          },
        ],
        makeLineMap(),
      );

      const formatted = formatValidationErrors(result.errors);
      expect(formatted).toContain('Invalid finding position');
      expect(formatted).toContain('oldPath: src/App.java\n  newPath: src/App.java\n  newLine: 99');
      expect(formatted).toContain('newLine: 99');
      expect(formatted).toContain('src/App.java');
    });

    it('formats removed-line errors with old line details only', () => {
      const result = validateFindings(
        [
          {
            oldPath: 'src/App.java',
            newPath: 'src/App.java',
            oldLine: 99,
            body: 'Not in diff',
            severity: 'high',
            category: 'correctness',
          },
        ],
        makeLineMap(),
      );

      const formatted = formatValidationErrors(result.errors);
      expect(formatted).toContain('oldPath: src/App.java');
      expect(formatted).toContain('newPath: src/App.java');
      expect(formatted).toContain('oldLine: 99');
      expect(formatted).not.toContain('newLine:');
    });

    it('omits missing location fields when formatting schema errors', () => {
      const formatted = formatValidationErrors([
        {
          index: 0,
          finding: {
            oldPath: '',
            newPath: 'src/App.java',
            oldLine: undefined,
            newLine: undefined,
            body: 'No line',
            severity: 'high',
            category: 'correctness',
          },
          message: 'schema failed',
        },
      ]);

      expect(formatted).not.toContain('oldPath:');
      expect(formatted).toContain('newPath: src/App.java');
      expect(formatted).not.toContain('oldLine:');
      expect(formatted).not.toContain('newLine:');
      expect(formatted).toContain('schema failed');
    });

    it('joins multiple formatted errors with a divider', () => {
      const formatted = formatValidationErrors([
        {
          index: 0,
          finding: {
            oldPath: 'src/App.java',
            newPath: 'src/App.java',
            newLine: 99,
            body: 'Missing added line',
            severity: 'high',
            category: 'correctness',
          },
          message: 'first error',
        },
        {
          index: 1,
          finding: {
            oldPath: 'src/App.java',
            newPath: 'src/App.java',
            oldLine: 99,
            body: 'Missing removed line',
            severity: 'medium',
            category: 'testing',
          },
          message: 'second error',
        },
      ]);

      expect(formatted).toContain('outputs/new-findings.json[0]');
      expect(formatted).toContain('outputs/new-findings.json[1]');
      expect(formatted).toContain('\n\n---\n\n');
      expect(formatted).toContain('first error');
      expect(formatted).toContain('second error');
    });
  });
});
