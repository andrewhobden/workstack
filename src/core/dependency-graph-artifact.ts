import { z } from 'zod'
import type { LocalDependencyGraph, LocalDependencyGraphDelta } from './types'

const relativePath = z.string().trim().min(1).max(2000).refine((value) =>
  !value.startsWith('/') && !/^[a-z]:/i.test(value) && !value.includes('\\') && !value.split('/').includes('..') &&
  ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127))
const nodeSchema = z.object({ path: relativePath })
const edgeSchema = z.object({ from: relativePath, to: relativePath })
const snapshotSchema = z.object({ nodes: z.array(nodeSchema).max(2000), edges: z.array(edgeSchema).max(10000), truncated: z.boolean().default(false) })
const deltaSchema = z.object({
  addedNodes: z.array(nodeSchema).max(1000), removedNodes: z.array(nodeSchema).max(1000),
  addedEdges: z.array(edgeSchema).max(1000), removedEdges: z.array(edgeSchema).max(1000), truncated: z.boolean()
})
const envelopeSchema = z.object({ version: z.literal(1), baselineArtifactId: z.string().min(1).nullable(), snapshot: snapshotSchema, delta: deltaSchema })

export interface DecodedDependencyGraph {
  formatVersion: 0 | 1
  format: 'snapshot-envelope' | 'legacy-envelope' | 'legacy-snapshot' | 'metadata-snapshot'
  baselineArtifactId: string | null
  snapshot: LocalDependencyGraph
  delta?: LocalDependencyGraphDelta
  truncated: boolean
}

/** One bounded decoder for automation output, legacy artifacts, deltas and launch consumers. */
export function decodeDependencyGraphArtifact(content: string, metadata: Record<string, unknown> = {}): DecodedDependencyGraph | undefined {
  if (content.length > 4_000_000) return undefined
  let value: unknown
  try { value = JSON.parse(content.match(/```json\s*\n([\s\S]*?)\n```/)?.[1] ?? content) } catch { value = undefined }
  if (value && typeof value === 'object' && ('version' in value || 'snapshot' in value)) {
    const versioned = 'version' in value
    const parsed = (versioned ? envelopeSchema : envelopeSchema.omit({ version: true })).safeParse(value)
    if (!parsed.success) return undefined
    return { formatVersion: versioned ? 1 : 0, format: versioned ? 'snapshot-envelope' : 'legacy-envelope', baselineArtifactId: parsed.data.baselineArtifactId,
      snapshot: parsed.data.snapshot, delta: parsed.data.delta, truncated: parsed.data.snapshot.truncated || parsed.data.delta.truncated }
  }
  const legacy = snapshotSchema.safeParse(value)
  if (legacy.success) return { formatVersion: 0, format: 'legacy-snapshot', baselineArtifactId: null, snapshot: legacy.data, truncated: legacy.data.truncated }
  const fallback = snapshotSchema.safeParse(metadata.graph)
  return fallback.success ? { formatVersion: 0, format: 'metadata-snapshot', baselineArtifactId: null, snapshot: fallback.data, truncated: fallback.data.truncated || metadata.truncated === true } : undefined
}

export function encodeDependencyGraphArtifact(snapshot: LocalDependencyGraph, delta: LocalDependencyGraphDelta, baselineArtifactId: string | null): string {
  return `\`\`\`json\n${JSON.stringify(envelopeSchema.parse({ version: 1, baselineArtifactId, snapshot, delta }), null, 2)}\n\`\`\``
}
