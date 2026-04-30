import { describe, it, expect } from 'vitest';
import { validateFindings, formatValidationErrors } from './finding-validator.js';
import type { LineMap } from './patch-parser.js';

const makeLineMap = (): LineMap => ({
  files: [
    {
      oldPath: 'src/App.java',
      newPath: 'src/App.java',
      status: 'modified',
      hunks: [],
      lines: [
        { type: 'context', oldLine: 1, newLine: 1, text: 'class App {' },
        { type: 'added', newLine: 2, text: '    private String name;' },
        { type: 'removed', oldLine: 2, text: '    private int age;' },
        { type: 'context', oldLine: 3, newLine: 3, text: '}' },
        { type: 'context', oldLine: 10, newLine: 10, text: '    validate(user);' },
        { type: 'added', newLine: 11, text: '    audit.log(user);' },
        { type: 'context', oldLine: 11, newLine: 12, text: '    notify(user);' },
      ],
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
    });

    it('rejects invalid category', () => {
      const findings = [
        {
          oldPath: 'src/App.java',
          newPath: 'src/App.java',
          newLine: 2,
          body: 'Bad category',
          severity: 'high',
          category: 'bug',
        },
      ];

      const result = validateFindings(findings, makeLineMap());
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Schema error');
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
      expect(formatted).toContain('newLine: 99');
      expect(formatted).toContain('src/App.java');
    });
  });
});
