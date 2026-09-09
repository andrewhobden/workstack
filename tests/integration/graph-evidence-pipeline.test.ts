import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectStore } from '../../src/core/project-store'
import { ProjectsService } from '../../src/core/projects-service'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { decodeDependencyGraphArtifact } from '../../src/core/dependency-graph-artifact'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'
import { buildCopilotSessionContext } from '../../src/main/copilot-launcher'
import { WorkstackMcpTools } from '../../src/mcp/server'
import type { GraphNeighborhood } from '../../src/core/evidence-graph-contracts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

it('carries real automation-produced import evidence through durable artifacts, launch decoding and bounded MCP navigation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-graph-pipeline-'))
  roots.push(root)
  const projects = new ProjectsService(new ProjectRegistry(path.join(root, 'registry.json')))
  const project = await projects.createProject({ rootPath: path.join(root, 'project'), name: 'Graph pipeline' })
  await mkdir(path.join(project.rootPath, 'src'))
  await writeFile(path.join(project.rootPath, 'src/api.ts'), "import { schema } from './schema'\nexport const api = schema\n")
  await writeFile(path.join(project.rootPath, 'src/schema.ts'), 'export const schema = { version: 1 }\n')
  const task = await projects.createWorkItem(project.id, { title: 'Update API schema', descriptionMarkdown: 'Preserve the API import contract.' })
  const service = new WikiAutomationService(projects, { propose: async () => '# API\n\nThe API imports its schema from src/schema.ts.' } as never)
  const job = await service.requestFullCodebaseRescan(project.id)
  await (service as unknown as { processProject(id: string): Promise<void> }).processProject(project.id)
  const store = await ProjectStore.open(project.rootPath)
  let artifact
  try {
    const repository = new WikiAutomationRepository(store)
    expect(repository.getJob(job.id).status).toBe('completed')
    artifact = repository.listArtifacts(job.id).find((entry) => entry.kind === 'dependency_graph')!
    expect(decodeDependencyGraphArtifact(artifact.contentMarkdown)).toMatchObject({ formatVersion: 1, snapshot: { edges: [{ from: 'src/api.ts', to: 'src/schema.ts' }] } })
    expect(repository.getDependencyGraphSnapshot(artifact)?.edges).toEqual([{ from: 'src/api.ts', to: 'src/schema.ts' }])
  } finally { store.close() }
  const context = await buildCopilotSessionContext(await projects.getProject(project.id), task)
  expect(context).toContain('src/api.ts -> src/schema.ts')
  expect(context).toContain(`Graph artifact revision: ${artifact.id}`)
  const tools = new WorkstackMcpTools(projects)
  const graph = await tools.call('workstack_query_evidence_graph', { project: project.name, node_id: 'file:src/api.ts', direction: 'outgoing', edge_types: ['imports'], bases: ['observed'], depth: 1, max_nodes: 10, max_edges: 10 }) as GraphNeighborhood
  expect(graph).toMatchObject({ nodes: [{ id: 'file:src/api.ts' }, { id: 'file:src/schema.ts', path: [{ direction: 'outgoing' }] }],
    edges: [{ basis: 'observed', provenanceState: 'current', graphRevisionId: artifact.id, provenance: { sourceId: artifact.id, revisionId: artifact.id } }], truncated: false })
  await expect(tools.call('workstack_query_evidence_graph', { project: project.name, node_id: 'file:src/api.ts', max_edges: 501 })).rejects.toThrow()
  await expect(tools.call('workstack_query_evidence_graph', { project: project.name, node_id: 'file:src/api.ts', inferred: true })).rejects.toThrow()
  // Reconcile the same producer scope from a subsequent real scan, without retaining removed imports.
  await writeFile(path.join(project.rootPath, 'src/api.ts'), 'export const api = {}\n')
  await service.requestFullCodebaseRescan(project.id)
  await (service as unknown as { processProject(id: string): Promise<void> }).processProject(project.id)
  const refreshed = await tools.call('workstack_query_evidence_graph', { project: project.name, node_id: 'file:src/api.ts' }) as GraphNeighborhood
  expect(refreshed.edges).toEqual([])
  expect(refreshed.revisions[0].revisionId).not.toBe(artifact.id)
  const record = await projects.createKnowledgeRecord(project.id, { kind: 'requirement', title: 'API stability', markdown: 'Preserve API compatibility.', status: 'active' })
  const entity = await projects.createProjectEntity(project.id, { kind: 'component', displayName: 'API', aliases: ['Public API'], definition: 'The API component.' })
  expect(await tools.call('workstack_list_knowledge_records', { project: project.name, kind: 'requirement', limit: 1 })).toMatchObject({ records: [{ id: record.id }] })
  expect(await tools.call('workstack_get_knowledge_record', { project: project.name, record_id: record.id })).toMatchObject({ record: { id: record.id } })
  expect(await tools.call('workstack_check_knowledge_records', { project: project.name })).toMatchObject({ findings: expect.arrayContaining([expect.objectContaining({ recordId: record.id, code: 'missing_evidence' })]) })
  expect(await tools.call('workstack_lookup_project_directory', { project: project.name, query: 'Public API' })).toMatchObject({ match: 'exact', candidates: [{ id: entity.id }] })
  expect(await tools.call('workstack_get_project_entity', { project: project.name, entity_id: entity.id })).toMatchObject({ entity: { id: entity.id }, canonicalEntity: { id: entity.id } })
  await expect(tools.call('workstack_list_knowledge_records', { project: project.name, limit: 101 })).rejects.toThrow()
})
