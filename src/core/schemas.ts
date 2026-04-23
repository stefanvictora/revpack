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
