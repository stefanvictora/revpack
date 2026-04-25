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

export const severitySchema = z.enum(['blocker', 'high', 'medium', 'low', 'nit']);

export const findingCategorySchema = z.enum([
  'security',
  'correctness',
  'performance',
  'testing',
  'architecture',
  'style',
  'documentation',
  'naming',
  'error-handling',
  'general',
]);

export const newFindingSchema = z.object({
  oldPath: z.string().min(1),
  newPath: z.string().min(1),
  oldLine: z.number().int().positive().optional(),
  newLine: z.number().int().positive().optional(),
  body: z.string().min(1),
  severity: severitySchema,
  category: findingCategorySchema,
}).refine(
  (f) => f.oldLine != null || f.newLine != null,
  { message: 'At least one of oldLine or newLine is required' },
);

export const replyDispositionSchema = z.enum([
  'already_fixed',
  'explain_only',
  'reply_only',
  'suggest_fix',
  'disagree',
  'escalate',
]);

export const replyDraftSchema = z.object({
  threadId: z.string().min(1),
  body: z.string().min(1),
  resolve: z.boolean(),
  disposition: replyDispositionSchema.optional(),
});

export const newFindingsArraySchema = z.array(newFindingSchema);
export const repliesArraySchema = z.array(replyDraftSchema);

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
