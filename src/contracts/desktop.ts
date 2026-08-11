import { z } from 'zod'
import { WORK_ITEM_PRIORITIES, WORK_ITEM_SOURCES, WORK_ITEM_STATUSES, WORK_ITEM_TYPES } from '../core/types'

export const projectIdSchema = z.string().uuid()

export const createProjectInputSchema = z
  .object({
    rootPath: z.string().trim().min(1),
    name: z.string().trim().min(1),
    description: z.string().optional(),
    workItemPrefix: z.string().regex(/^[A-Z][A-Z0-9]*$/).optional()
  })
  .strict()

export const updateProjectInputSchema = z
  .object({
    projectId: projectIdSchema,
    name: z.string().optional(),
    description: z.string().optional(),
    settings: z
      .object({
        defaultLeaseSeconds: z.number().int().min(60).optional(),
        heartbeatSeconds: z.number().int().min(30).optional(),
        autoReleaseExpiredClaims: z.boolean().optional(),
        autoUpdateKnowledgeOnCompletion: z.boolean().optional()
      })
      .strict()
      .optional()
  })
  .strict()

export const workItemFiltersSchema = z
  .object({
    status: z.enum(WORK_ITEM_STATUSES).optional(),
    type: z.enum(WORK_ITEM_TYPES).optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    source: z.enum(WORK_ITEM_SOURCES).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional()
  })
  .strict()

export const createWorkItemInputSchema = z
  .object({
    projectId: projectIdSchema,
    type: z.enum(WORK_ITEM_TYPES).optional(),
    title: z.string().trim().min(1),
    descriptionMarkdown: z.string().optional(),
    acceptanceCriteriaMarkdown: z.string().optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional(),
    source: z.enum(WORK_ITEM_SOURCES).optional(),
    createdBy: z.string().optional()
  })
  .strict()

export const workItemReferenceSchema = z
  .object({
    projectId: projectIdSchema,
    workItemId: z.string().uuid()
  })
  .strict()

export const updateWorkItemInputSchema = workItemReferenceSchema
  .extend({
    type: z.enum(WORK_ITEM_TYPES).optional(),
    title: z.string().optional(),
    descriptionMarkdown: z.string().optional(),
    acceptanceCriteriaMarkdown: z.string().optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional()
  })
  .strict()

export const forceReleaseWorkItemInputSchema = workItemReferenceSchema
  .extend({
    reason: z.string().trim().min(1)
  })
  .strict()

export const knowledgeSourceInputSchema = z
  .object({
    projectId: projectIdSchema,
    displayName: z.string().trim().min(1),
    filename: z.string().trim().min(1),
    content: z.string().trim().min(1)
  })
  .strict()

export const planningProposalInputSchema = z
  .object({
    projectId: projectIdSchema,
    sessionId: z.string().uuid(),
    title: z.string().optional(),
    type: z.enum(WORK_ITEM_TYPES).optional(),
    descriptionMarkdown: z.string().optional(),
    requirementsMarkdown: z.string().optional(),
    acceptanceCriteriaMarkdown: z.string().optional(),
    implementationContextMarkdown: z.string().optional(),
    relatedReferences: z.array(z.string()).optional(),
    priority: z.enum(WORK_ITEM_PRIORITIES).optional()
  })
  .strict()

export const binaryAttachmentInputSchema = workItemReferenceSchema
  .extend({
    data: z.instanceof(Uint8Array),
    originalFilename: z.string().trim().min(1),
    mimeType: z.string().trim().min(1).optional()
  })
  .strict()
