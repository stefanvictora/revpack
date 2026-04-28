export { WorkspaceManager } from './workspace-manager.js';
export { GitHelper } from './git-helper.js';
export { parsePatch } from './patch-parser.js';
export type { LineMap, FileEntry, LineEntry, LineType, FileStatus } from './patch-parser.js';
export { validateFindings, formatValidationErrors } from './finding-validator.js';
export type { ValidationError, ValidationResult } from './finding-validator.js';
export { computeThreadDigest, computeAggregateThreadsDigest, computeContentHash } from './thread-digest.js';
