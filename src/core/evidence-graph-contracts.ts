import { z } from 'zod'

export const graphNodeTypeSchema = z.enum(['file', 'test', 'component', 'term', 'decision', 'requirement', 'risk', 'task', 'source', 'wiki'])
export const graphEdgeTypeSchema = z.enum(['imports', 'implements', 'tests', 'requires', 'affects', 'documents', 'supports', 'supersedes', 'mentions', 'part_of', 'related_to'])
export const graphBasisSchema = z.enum(['observed', 'declared', 'inferred'])
export const graphProvenanceSchema = z.object({
  sourceId: z.string().min(1).max(200), revisionId: z.string().min(1).max(200), locator: z.string().min(1).max(4000),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/), passageId: z.string().min(1).max(200).optional()
}).strict()
const nodeSchema = z.object({ type: graphNodeTypeSchema, reference: z.string().min(1).max(2000), label: z.string().min(1).max(1000), resolved: z.boolean().default(true) }).strict()
const nodeId = z.string().min(1).max(2100).refine((value) => graphNodeTypeSchema.safeParse(value.split(':')[0]).success && value.indexOf(':') < value.length - 1)
export const graphScopeInputSchema = z.object({
  scopeKey: z.string().min(1).max(200), revisionId: z.string().min(1).max(200), truncated: z.boolean().default(false),
  nodes: z.array(nodeSchema).max(2000),
  edges: z.array(z.object({ from: nodeId, to: nodeId, type: graphEdgeTypeSchema, basis: graphBasisSchema, provenance: graphProvenanceSchema }).strict()).max(10000)
}).strict()
export const graphQuerySchema = z.object({
  nodeId, direction: z.enum(['outgoing', 'incoming', 'both']).default('both'),
  edgeTypes: z.array(graphEdgeTypeSchema).max(11).optional(), bases: z.array(graphBasisSchema).max(3).optional(),
  depth: z.number().int().min(0).max(5).default(2), maxNodes: z.number().int().min(1).max(200).default(50), maxEdges: z.number().int().min(1).max(500).default(100)
}).strict()
export type GraphScopeInput = z.input<typeof graphScopeInputSchema>
export type GraphQuery = z.input<typeof graphQuerySchema>
export type GraphNodeType = z.infer<typeof graphNodeTypeSchema>
export type GraphProvenance = z.infer<typeof graphProvenanceSchema>
export interface GraphNode { id: string; type: GraphNodeType; reference: string; label: string; resolved: boolean }
export interface GraphPathStep { edgeId: string; from: string; to: string; direction: 'outgoing' | 'incoming' }
export interface GraphEdge {
  id: string; from: string; to: string; type: z.infer<typeof graphEdgeTypeSchema>; basis: z.infer<typeof graphBasisSchema>;
  scopeKey: string; graphRevisionId: string; provenance: GraphProvenance;
  provenanceState: 'current' | 'stale' | 'unavailable' | 'unverified'; unresolved: boolean
}
export interface GraphNeighborhood {
  nodes: Array<GraphNode & { distance: number; path: GraphPathStep[] }>
  edges: Array<GraphEdge & { direction: 'outgoing' | 'incoming'; path: GraphPathStep[] }>
  revisions: Array<{ scopeKey: string; revisionId: string; contentHash: string; truncated: boolean }>
  truncated: boolean; limits: { depth: number; maxNodes: number; maxEdges: number }; truncationReasons: string[]
}
export function graphNodeId(type: GraphNodeType, reference: string): string { return `${type}:${reference}` }
