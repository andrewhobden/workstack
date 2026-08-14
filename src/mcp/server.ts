import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { WorkstackError } from '../core/errors'
import { ProjectsService } from '../core/projects-service'
import type { CompletionInput, WorkItem } from '../core/types'

export const MCP_TOOL_NAMES = [
  'workstack_list_projects',
  'workstack_search_knowledge',
  'workstack_list_backlog',
  'workstack_create_work_item',
  'workstack_create_feature',
  'workstack_create_bug',
  'workstack_search_completed',
  'workstack_get_work_item',
  'workstack_get_work_item_handoff',
  'workstack_list_wiki_articles',
  'workstack_get_wiki_article',
  'workstack_claim_work_item',
  'workstack_heartbeat_work_item',
  'workstack_release_work_item',
  'workstack_block_work_item',
  'workstack_complete_work_item'
] as const

export type McpToolName = (typeof MCP_TOOL_NAMES)[number]

const projectReferenceSchema = z.object({
  project: z.string().trim().min(1).describe('Project name shown in Workstack. A project UUID is also accepted for compatibility.').optional(),
  project_id: z.string().uuid().describe('Deprecated: use the visible project name in project instead.').optional()
})
const workItemReferenceSchema = projectReferenceSchema.extend({ work_item_id: z.string().trim().min(1) })
const wikiArticleReferenceSchema = projectReferenceSchema.extend({ slug: z.string().trim().min(1) })
const completionSchema = z.object({
  summary_markdown: z.string().trim().min(1),
  session_summary_markdown: z.string().optional(),
  implementation_notes_markdown: z.string().optional(),
  validation_markdown: z.string().optional(),
  known_limitations_markdown: z.string().optional(),
  files_changed: z.array(z.string().trim().min(1)).optional(),
  components_changed: z.array(z.string().trim().min(1)).optional(),
  commit_sha: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  pr_url: z.string().url().nullable().optional()
})

const searchKnowledgeInputSchema = projectReferenceSchema.extend({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(100).default(10)
  })
const listBacklogInputSchema = projectReferenceSchema.extend({
    type: z.enum(['feature', 'bug', 'chore']).optional(),
    priority: z.enum(['high', 'normal', 'low']).optional(),
    query: z.string().optional(),
    limit: z.number().int().min(1).max(100).default(50)
  })
const searchCompletedInputSchema = projectReferenceSchema.extend({
    query: z.string().trim().min(1),
    limit: z.number().int().min(1).max(100).default(20)
  })
const createWorkItemInputSchema = projectReferenceSchema.extend({
  type: z.enum(['feature', 'bug', 'chore']),
  title: z.string().trim().min(1),
  description_markdown: z.string().optional(),
  acceptance_criteria_markdown: z.string().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  created_by: z.string().trim().min(1).optional()
})
const createFeatureOrBugInputSchema = projectReferenceSchema.extend({
  title: z.string().trim().min(1),
  description_markdown: z.string().optional(),
  acceptance_criteria_markdown: z.string().optional(),
  priority: z.enum(['high', 'normal', 'low']).optional(),
  created_by: z.string().trim().min(1).optional()
})
const mcpToolInputSchemas = {
  workstack_list_projects: z.object({}),
  workstack_search_knowledge: searchKnowledgeInputSchema,
  workstack_list_backlog: listBacklogInputSchema,
  workstack_create_work_item: createWorkItemInputSchema,
  workstack_create_feature: createFeatureOrBugInputSchema,
  workstack_create_bug: createFeatureOrBugInputSchema,
  workstack_search_completed: searchCompletedInputSchema,
  workstack_get_work_item: workItemReferenceSchema,
  workstack_get_work_item_handoff: workItemReferenceSchema,
  workstack_list_wiki_articles: projectReferenceSchema,
  workstack_get_wiki_article: wikiArticleReferenceSchema,
  workstack_claim_work_item: workItemReferenceSchema.extend({
    agent_id: z.string().trim().min(1),
    agent_display_name: z.string().trim().min(1).optional(),
    session_id: z.string().trim().min(1).optional(),
    requested_lease_seconds: z.number().int().min(60).optional()
  }),
  workstack_heartbeat_work_item: workItemReferenceSchema.extend({ claim_token: z.string().trim().min(1) }),
  workstack_release_work_item: workItemReferenceSchema.extend({
    claim_token: z.string().trim().min(1),
    reason: z.string().trim().min(1).optional()
  }),
  workstack_block_work_item: workItemReferenceSchema.extend({
    claim_token: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    retain_claim: z.boolean().default(false)
  }),
  workstack_complete_work_item: workItemReferenceSchema.extend({
    claim_token: z.string().trim().min(1),
    completion: completionSchema
  })
} as const

export class WorkstackMcpTools {
  constructor(private readonly projects: ProjectsService) {}

  async call(name: McpToolName, input: unknown): Promise<unknown> {
    switch (name) {
      case 'workstack_list_projects':
        return this.listProjects()
      case 'workstack_search_knowledge':
        return this.searchKnowledge(input)
      case 'workstack_list_backlog':
        return this.listBacklog(input)
      case 'workstack_create_work_item':
        return this.createWorkItem(input)
      case 'workstack_create_feature':
        return this.createWorkItem(input, 'feature')
      case 'workstack_create_bug':
        return this.createWorkItem(input, 'bug')
      case 'workstack_search_completed':
        return this.searchCompleted(input)
      case 'workstack_get_work_item':
        return this.getWorkItem(input)
      case 'workstack_get_work_item_handoff':
        return this.getWorkItemHandoff(input)
      case 'workstack_list_wiki_articles':
        return this.listWikiArticles(input)
      case 'workstack_get_wiki_article':
        return this.getWikiArticle(input)
      case 'workstack_claim_work_item':
        return this.claim(input)
      case 'workstack_heartbeat_work_item':
        return this.heartbeat(input)
      case 'workstack_release_work_item':
        return this.release(input)
      case 'workstack_block_work_item':
        return this.block(input)
      case 'workstack_complete_work_item':
        return this.complete(input)
    }
  }

  private async listProjects(): Promise<{ projects: Array<{ id: string; name: string; description: string; backlog_count: number; in_progress_count: number; completed_count: number }> }> {
    const projects = await this.projects.listProjects()
    return {
      projects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        description: project.description,
        backlog_count: project.backlogCount,
        in_progress_count: project.inProgressCount,
        completed_count: project.completedCount
      }))
    }
  }

  private async searchKnowledge(input: unknown): Promise<{
    results: Array<{ source_type: string; source_id: string; title: string; excerpt: string; location: string; relevance: number; score: number }>
    groups: Array<{ source_type: string; label: string; results: Array<{ source_id: string; title: string; excerpt: string; location: string; relevance: number }> }>
  }> {
    const parsed = searchKnowledgeInputSchema.parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const retrieval = await this.projects.retrieveKnowledge(projectId, parsed.query, parsed.limit)
    return {
      results: retrieval.results.map((result) => ({
        source_type: result.sourceType,
        source_id: result.sourceId,
        title: result.title,
        excerpt: result.excerpt,
        location: result.location,
        relevance: result.relevance,
        score: result.relevance
      })),
      groups: retrieval.groups
        .filter((group) => group.results.length)
        .map((group) => ({
          source_type: group.sourceType,
          label: group.label,
          results: group.results.map((result) => ({
            source_id: result.sourceId,
            title: result.title,
            excerpt: result.excerpt,
            location: result.location,
            relevance: result.relevance
          }))
        }))
    }
  }

  private async listBacklog(input: unknown): Promise<{ work_items: Array<Pick<WorkItem, 'id' | 'displayId' | 'type' | 'title' | 'priority'>> }> {
    const parsed = listBacklogInputSchema.parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const items = await this.projects.listWorkItems(projectId, {
      status: 'backlog',
      type: parsed.type,
      priority: parsed.priority,
      query: parsed.query,
      limit: parsed.limit
    })
    return {
      work_items: items.map(({ id, displayId, type, title, priority }) => ({ id, displayId, type, title, priority }))
    }
  }

  private async createWorkItem(input: unknown, fixedType?: WorkItem['type']): Promise<{ work_item: WorkItem }> {
    if (fixedType) {
      const parsed = createFeatureOrBugInputSchema.parse(input)
      return this.persistMcpWorkItem(await this.resolveProjectId(parsed), parsed, fixedType)
    }
    const parsed = createWorkItemInputSchema.parse(input)
    return this.persistMcpWorkItem(await this.resolveProjectId(parsed), parsed, parsed.type)
  }

  private async persistMcpWorkItem(
    projectId: string,
    input: z.infer<typeof createFeatureOrBugInputSchema>,
    type: WorkItem['type']
  ): Promise<{ work_item: WorkItem }> {
    const workItem = await this.projects.createWorkItem(projectId, {
      type,
      title: input.title,
      descriptionMarkdown: input.description_markdown,
      acceptanceCriteriaMarkdown: input.acceptance_criteria_markdown,
      priority: input.priority,
      source: 'mcp',
      createdBy: input.created_by
    })
    return { work_item: workItem }
  }

  private async searchCompleted(input: unknown): Promise<{ work_items: WorkItem[] }> {
    const parsed = searchCompletedInputSchema.parse(input)
    const projectId = await this.resolveProjectId(parsed)
    return {
      work_items: await this.projects.listWorkItems(projectId, {
        status: 'completed',
        query: parsed.query,
        limit: parsed.limit
      })
    }
  }

  private async getWorkItem(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const [attachments, claim] = await Promise.all([
      this.projects.listAttachments(projectId, item.id),
      this.projects.getActiveClaim(projectId, item.id)
    ])
    return { work_item: item, attachments, current_claim: claim }
  }

  private async getWorkItemHandoff(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const [attachments, claim, completion] = await Promise.all([
      this.projects.listAttachments(projectId, item.id),
      this.projects.getActiveClaim(projectId, item.id),
      this.projects.getCompletion(projectId, item.id)
    ])
    return { work_item: item, attachments, current_claim: claim, completion }
  }

  private async listWikiArticles(input: unknown): Promise<{ articles: Array<{ slug: string; preview: string }> }> {
    const parsed = projectReferenceSchema.parse(input)
    const articles = await this.projects.listWikiArticles(await this.resolveProjectId(parsed))
    return { articles: articles.map((article) => ({ slug: article.slug, preview: article.content.slice(0, 240) })) }
  }

  private async getWikiArticle(input: unknown): Promise<{ article: { slug: string; content: string } }> {
    const parsed = wikiArticleReferenceSchema.parse(input)
    const articles = await this.projects.listWikiArticles(await this.resolveProjectId(parsed))
    const article = articles.find((candidate) => candidate.slug === parsed.slug)
    if (!article) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The requested wiki article does not exist.')
    }
    return { article }
  }

  private async claim(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.extend({
      agent_id: z.string().trim().min(1),
      agent_display_name: z.string().trim().min(1).optional(),
      session_id: z.string().trim().min(1).optional(),
      requested_lease_seconds: z.number().int().min(60).optional()
    }).parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const result = await this.projects.claimWorkItem(projectId, item.id, {
      agentId: parsed.agent_id,
      agentDisplayName: parsed.agent_display_name,
      sessionId: parsed.session_id,
      requestedLeaseSeconds: parsed.requested_lease_seconds
    })
    return {
      claimed: true,
      work_item_id: item.displayId,
      claim_token: result.claimToken,
      lease_expires_at: result.leaseExpiresAt,
      recommended_heartbeat_seconds: result.recommendedHeartbeatSeconds
    }
  }

  private async heartbeat(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.extend({ claim_token: z.string().trim().min(1) }).parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const claim = await this.projects.heartbeatWorkItem(projectId, item.id, parsed.claim_token)
    return { lease_expires_at: claim.leaseExpiresAt, last_heartbeat_at: claim.lastHeartbeatAt }
  }

  private async release(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.extend({
      claim_token: z.string().trim().min(1),
      reason: z.string().trim().min(1).optional()
    }).parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    await this.projects.releaseWorkItem(projectId, item.id, parsed.claim_token, parsed.reason)
    return { released: true }
  }

  private async block(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.extend({
      claim_token: z.string().trim().min(1),
      reason: z.string().trim().min(1),
      retain_claim: z.boolean().default(false)
    }).parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const claim = await this.projects.blockWorkItem(projectId, item.id, parsed.claim_token, {
      reason: parsed.reason,
      retainClaim: parsed.retain_claim
    })
    return { blocked: true, claim_retained: claim.state === 'active' }
  }

  private async complete(input: unknown): Promise<unknown> {
    const parsed = workItemReferenceSchema.extend({ claim_token: z.string().trim().min(1), completion: completionSchema }).parse(input)
    const projectId = await this.resolveProjectId(parsed)
    const item = await this.resolveWorkItem(projectId, parsed.work_item_id)
    const completion = await this.projects.completeWorkItem(
      projectId,
      item.id,
      parsed.claim_token,
      toCompletionInput(parsed.completion)
    )
    return { completed: true, work_item_id: item.displayId, completed_at: completion.createdAt }
  }

  private async resolveProjectId(input: { project?: string; project_id?: string }): Promise<string> {
    return this.projects.resolveProjectReference(input.project ?? input.project_id ?? '')
  }

  private async resolveWorkItem(projectId: string, identifier: string): Promise<WorkItem> {
    try {
      return await this.projects.getWorkItem(projectId, identifier)
    } catch (error) {
      if (!(error instanceof WorkstackError) || error.code !== 'WORK_ITEM_NOT_FOUND') {
        throw error
      }
    }
    const item = (await this.projects.listWorkItems(projectId, { limit: 100 })).find(
      (candidate) => candidate.displayId === identifier
    )
    if (!item) {
      throw new WorkstackError('WORK_ITEM_NOT_FOUND', 'The requested work item does not exist.')
    }
    return item
  }
}

export function createMcpServer(projects: ProjectsService): McpServer {
  const tools = new WorkstackMcpTools(projects)
  const server = new McpServer(
    { name: 'workstack', version: '0.1.0' },
    { instructions: 'Claim work before making changes, heartbeat while active, and complete with validation. Never edit .workstack/workstack.db directly.' }
  )

  for (const name of MCP_TOOL_NAMES) {
    server.registerTool(
      name,
      { description: `Workstack tool: ${name}`, inputSchema: mcpToolInputSchemas[name] },
      async (input: unknown) => asMcpResult(tools.call(name, input))
    )
  }
  return server
}

export async function runStdioServer(projects: ProjectsService): Promise<void> {
  const server = createMcpServer(projects)
  await server.connect(new StdioServerTransport())
}

function asMcpResult(result: Promise<unknown>): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  return result
    .then((value) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] }))
    .catch((error: unknown) => {
      const normalized = error instanceof WorkstackError
        ? { code: error.code, message: error.message }
        : { code: 'INTERNAL_ERROR', message: 'Workstack could not complete the requested operation.' }
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: normalized }) }], isError: true } as never
    })
}

function toCompletionInput(input: z.infer<typeof completionSchema>): CompletionInput {
  return {
    summaryMarkdown: input.summary_markdown,
    sessionSummaryMarkdown: input.session_summary_markdown,
    implementationNotesMarkdown: input.implementation_notes_markdown,
    validationMarkdown: input.validation_markdown,
    knownLimitationsMarkdown: input.known_limitations_markdown,
    filesChanged: input.files_changed,
    componentsChanged: input.components_changed,
    commitSha: input.commit_sha,
    branch: input.branch,
    prUrl: input.pr_url
  }
}
