import { describe, it, expect } from 'vitest';
import { parsePatch } from './patch-parser.js';

describe('parsePatch', () => {
  describe('added lines', () => {
    it('parses a patch with an added line', () => {
      const patch = `diff --git a/src/App.java b/src/App.java
index 111..222 100644
--- a/src/App.java
+++ b/src/App.java
@@ -1,2 +1,3 @@
 class App {
+    private String name;
 }`;

      const result = parsePatch(patch);
      expect(result.files).toHaveLength(1);

      const file = result.files[0];
      expect(file.oldPath).toBe('src/App.java');
      expect(file.newPath).toBe('src/App.java');
      expect(file.status).toBe('modified');

      expect(file.lines).toEqual([
        { type: 'context', oldLine: 1, newLine: 1, text: 'class App {' },
        { type: 'added', newLine: 2, text: '    private String name;' },
        { type: 'context', oldLine: 2, newLine: 3, text: '}' },
      ]);
    });
  });

  describe('removed lines', () => {
    it('parses a patch with a removed line', () => {
      const patch = `diff --git a/src/App.java b/src/App.java
index 111..222 100644
--- a/src/App.java
+++ b/src/App.java
@@ -1,3 +1,2 @@
 class App {
-    private String name;
}`;

      const result = parsePatch(patch);
      const file = result.files[0];

      const removed = file.lines.find((l) => l.type === 'removed');
      expect(removed).toEqual({ type: 'removed', oldLine: 2, text: '    private String name;' });
    });
  });

  describe('modified lines', () => {
    it('parses a modification (remove + add)', () => {
      const patch = `diff --git a/src/App.java b/src/App.java
index 111..222 100644
--- a/src/App.java
+++ b/src/App.java
@@ -5,3 +5,3 @@
     validate(user);
-    repository.save(user);
+    repository.saveAndFlush(user);
     notify(user);`;

      const result = parsePatch(patch);
      const file = result.files[0];

      expect(file.lines).toEqual([
        { type: 'context', oldLine: 5, newLine: 5, text: '    validate(user);' },
        { type: 'removed', oldLine: 6, text: '    repository.save(user);' },
        { type: 'added', newLine: 6, text: '    repository.saveAndFlush(user);' },
        { type: 'context', oldLine: 7, newLine: 7, text: '    notify(user);' },
      ]);
    });
  });

  describe('context line shifted', () => {
    it('computes shifted line numbers correctly', () => {
      const patch = `diff --git a/src/App.java b/src/App.java
index 111..222 100644
--- a/src/App.java
+++ b/src/App.java
@@ -10,3 +10,4 @@
     validate(user);
+    audit.log(user);
     notify(user);`;

      const result = parsePatch(patch);
      const file = result.files[0];

      expect(file.lines).toEqual([
        { type: 'context', oldLine: 10, newLine: 10, text: '    validate(user);' },
        { type: 'added', newLine: 11, text: '    audit.log(user);' },
        { type: 'context', oldLine: 11, newLine: 12, text: '    notify(user);' },
      ]);
    });
  });

  describe('renamed file', () => {
    it('parses rename metadata', () => {
      const patch = `diff --git a/src/OldName.java b/src/NewName.java
similarity index 88%
rename from src/OldName.java
rename to src/NewName.java
index 111..222 100644
--- a/src/OldName.java
+++ b/src/NewName.java
@@ -1,2 +1,3 @@
 class OldName {
+    void changed() {}
}`;

      const result = parsePatch(patch);
      const file = result.files[0];

      expect(file.oldPath).toBe('src/OldName.java');
      expect(file.newPath).toBe('src/NewName.java');
      expect(file.status).toBe('renamed');
    });
  });

  describe('new file', () => {
    it('parses an added file', () => {
      const patch = `diff --git a/src/NewFile.java b/src/NewFile.java
new file mode 100644
index 0000000..abc1234
--- /dev/null
+++ b/src/NewFile.java
@@ -0,0 +1,3 @@
+package com.example;
+
+public class NewFile {}`;

      const result = parsePatch(patch);
      const file = result.files[0];

      expect(file.oldPath).toBe('src/NewFile.java');
      expect(file.newPath).toBe('src/NewFile.java');
      expect(file.status).toBe('added');
      expect(file.lines).toHaveLength(3);
      expect(file.lines.every((l) => l.type === 'added')).toBe(true);
    });
  });

  describe('deleted file', () => {
    it('parses a deleted file', () => {
      const patch = `diff --git a/src/OldFile.java b/src/OldFile.java
deleted file mode 100644
index abc1234..0000000
--- a/src/OldFile.java
+++ /dev/null
@@ -1,3 +0,0 @@
-package com.example;
-
-public class OldFile {}`;

      const result = parsePatch(patch);
      const file = result.files[0];

      expect(file.oldPath).toBe('src/OldFile.java');
      expect(file.newPath).toBe('src/OldFile.java');
      expect(file.status).toBe('deleted');
      expect(file.lines.every((l) => l.type === 'removed')).toBe(true);
    });
  });

  describe('multiple files', () => {
    it('parses patches with multiple files', () => {
      const patch = `diff --git a/src/A.ts b/src/A.ts
--- a/src/A.ts
+++ b/src/A.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
diff --git a/src/B.ts b/src/B.ts
--- a/src/B.ts
+++ b/src/B.ts
@@ -1,2 +1,2 @@
-old
+new
 kept`;

      const result = parsePatch(patch);
      expect(result.files).toHaveLength(2);
      expect(result.files[0].newPath).toBe('src/A.ts');
      expect(result.files[1].newPath).toBe('src/B.ts');
    });
  });

  describe('no newline at end of file', () => {
    it('ignores "No newline at end of file" markers', () => {
      const patch = `diff --git a/src/App.ts b/src/App.ts
--- a/src/App.ts
+++ b/src/App.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
\\ No newline at end of file`;

      const result = parsePatch(patch);
      const file = result.files[0];
      expect(file.lines).toHaveLength(3);
      expect(file.lines.every((l) => l.type !== undefined)).toBe(true);
    });
  });

  describe('multiple hunks', () => {
    it('parses multiple hunks in one file', () => {
      const patch = `diff --git a/src/App.ts b/src/App.ts
--- a/src/App.ts
+++ b/src/App.ts
@@ -1,3 +1,4 @@
 line1
+added1
 line2
 line3
@@ -10,3 +11,4 @@
 line10
+added2
 line11
 line12`;

      const result = parsePatch(patch);
      const file = result.files[0];

      // First hunk
      expect(file.lines[0]).toEqual({ type: 'context', oldLine: 1, newLine: 1, text: 'line1' });
      expect(file.lines[1]).toEqual({ type: 'added', newLine: 2, text: 'added1' });

      // Second hunk
      const secondHunkStart = file.lines.findIndex((l) => l.oldLine === 10);
      expect(secondHunkStart).toBeGreaterThan(0);
      expect(file.lines[secondHunkStart]).toEqual({ type: 'context', oldLine: 10, newLine: 11, text: 'line10' });
    });
  });

  describe('empty patch', () => {
    it('returns empty files array for empty input', () => {
      const result = parsePatch('');
      expect(result.files).toHaveLength(0);
    });
  });

  describe('blank separators', () => {
    it('does not treat trailing blank lines as context lines', () => {
      const patch = `diff --git a/src/App.ts b/src/App.ts
--- a/src/App.ts
+++ b/src/App.ts
@@ -1,2 +1,3 @@
 line1
+added
 line2
`;

      const result = parsePatch(patch);
      expect(result.files[0].lines).toEqual([
        { type: 'context', oldLine: 1, newLine: 1, text: 'line1' },
        { type: 'added', newLine: 2, text: 'added' },
        { type: 'context', oldLine: 2, newLine: 3, text: 'line2' },
      ]);
    });
  });
});
