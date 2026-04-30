export { WorkspaceManager } from './workspace-manager.js';
export { GitHelper } from './git-helper.js';
export { parsePatch } from './patch-parser.js';
export type { LineMap, FileEntry, LineEntry, LineType, FileStatus } from './patch-parser.js';
export { mergeWithMarkers, extractMarkedSummary, MARKER_START, MARKER_END } from './description-summary.js';
export { validateFindings, formatValidationErrors } from './finding-validator.js';
export type { ValidationError, ValidationResult } from './finding-validator.js';
export { computeThreadDigest, computeAggregateThreadsDigest, computeContentHash } from './thread-digest.js';
export {
  parseCheckpointMarker,
  buildCheckpointState,
  encodeCheckpointState,
  buildReviewNoteBody,
  updateReviewNoteBody,
  CHECKPOINT_MARKER_START,
  CHECKPOINT_MARKER_END,
  REVIEW_NOTE_MARKER,
} from './checkpoint.js';
export type { CheckpointState, ParsedCheckpoint } from './checkpoint.js';
