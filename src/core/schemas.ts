import { z } from 'zod';

// Zod schemas for validation at system boundaries.

export const providerTypeSchema = z.enum(['gitlab', 'github']);
export const targetTypeSchema = z.enum(['merge_request', 'pull_request']);

export const reviewTargetRefSchema = z.object({
  provider: providerTypeSchema,
  repository: z.string().min(1),
  targetType: targetTypeSchema,
  targetId: z.string().min(1),
});

export const severitySchema = z.enum(['blocker', 'high', 'medium', 'low', 'info', 'nit']);
export const confidenceSchema = z.enum(['high', 'medium', 'low']);
export const findingStatusSchema = z.enum(['unreviewed', 'verified', 'invalid', 'fixed', 'replied', 'resolved']);
export const dispositionSchema = z.enum(['ignore', 'explain_only', 'reply_only', 'patch_only', 'patch_and_reply', 'escalate']);
export const checkResultSchema = z.enum(['passed', 'failed', 'not_run', 'skipped']);

export const findingSchema = z.object({
  type: z.literal('finding'),
  provider: providerTypeSchema,
  repository: z.string(),
  targetType: targetTypeSchema,
  targetId: z.string(),
  threadId: z.string(),
  commentId: z.string(),
  origin: z.enum(['human', 'bot', 'unknown']),
  severity: severitySchema,
  confidence: confidenceSchema,
  category: z.string(),
  status: findingStatusSchema,
  disposition: dispositionSchema,
  fileName: z.string(),
  lineStart: z.number().optional(),
  lineEnd: z.number().optional(),
  title: z.string(),
  problem: z.string(),
  validationSummary: z.string(),
  codegenInstructions: z.string().optional(),
  suggestions: z.array(z.string()),
  replyDraft: z.string(),
  checks: z.object({
    build: checkResultSchema,
    tests: checkResultSchema,
    lint: checkResultSchema,
  }),
});

export const configSchema = z.object({
  provider: providerTypeSchema,
  gitlabUrl: z.string().url().optional(),
  gitlabToken: z.string().min(1).optional(),
  githubToken: z.string().min(1).optional(),
  defaultRepository: z.string().optional(),
  bundleDir: z.string().default('.review-assist'),
  /** Path to a PEM-encoded CA certificate file for self-signed/internal TLS. */
  caFile: z.string().optional(),
  /** Set to false to disable TLS certificate verification (not recommended). */
  tlsVerify: z.boolean().default(true),
});

export type AppConfig = z.infer<typeof configSchema>;
