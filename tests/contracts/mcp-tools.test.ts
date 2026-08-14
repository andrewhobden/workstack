import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES, WorkstackMcpTools } from '../../src/mcp/server'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

describe('Workstack MCP tools', () => {
  it('exposes the specified tools and preserves agent claim-token boundaries', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-mcp-'))
    cleanupPaths.push(directory)
    const projects = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
    const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'MCP Project', workItemPrefix: 'MCP' })
    const workItem = await projects.createWorkItem(project.id, {
      title: 'Ship the MCP contract',
      descriptionMarkdown: 'Expose safe tools.'
    })
    const tools = new WorkstackMcpTools(projects)

    expect(MCP_TOOL_NAMES).toEqual([
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
    ])
    await expect(tools.call('workstack_list_projects', {})).resolves.toEqual({
      projects: [expect.objectContaining({ id: project.id, name: 'MCP Project' })]
    })
    await expect(tools.call('workstack_create_feature', {
      project: project.name,
      title: 'Create project discovery',
      description_markdown: 'Agents can discover visible projects.',
      priority: 'high',
      created_by: 'copilot'
    })).resolves.toMatchObject({
      work_item: {
        type: 'feature',
        source: 'mcp',
        createdBy: 'copilot',
        title: 'Create project discovery'
      }
    })
    await expect(tools.call('workstack_create_bug', {
      project: project.name,
      title: 'Report an agent issue'
    })).resolves.toMatchObject({ work_item: { type: 'bug', source: 'mcp' } })
    await expect(tools.call('workstack_create_work_item', {
      project: project.name,
      type: 'chore',
      title: 'Maintain MCP tools'
    })).resolves.toMatchObject({ work_item: { type: 'chore', source: 'mcp' } })
    await projects.addKnowledgeSource(project.id, {
      displayName: 'Architecture',
      filename: 'architecture.md',
      content: 'The schema keeps durable local project state.'
    })
    await expect(tools.call('workstack_search_knowledge', { project_id: project.id, query: 'durable state' })).resolves.toEqual({
      results: [
        expect.objectContaining({
          source_type: 'raw_source',
          source_id: expect.stringMatching(/^raw:/),
          title: 'Architecture',
          location: expect.stringMatching(/^knowledge\/raw\//),
          relevance: expect.any(Number)
        })
      ],
      groups: [
        expect.objectContaining({
          source_type: 'raw_source',
          results: [expect.objectContaining({ source_id: expect.stringMatching(/^raw:/) })]
        })
      ]
    })
    await expect(tools.call('workstack_list_backlog', { project: project.name })).resolves.toMatchObject({
      work_items: expect.arrayContaining([expect.objectContaining({ id: workItem.id, displayId: workItem.displayId })])
    })
    await projects.saveWikiArticle(project.id, 'handoff', 'Use the current worktree and preserve its branch.')
    await expect(tools.call('workstack_list_wiki_articles', { project: project.name })).resolves.toEqual({
      articles: [{ slug: 'handoff', preview: 'Use the current worktree and preserve its branch.' }]
    })
    await expect(tools.call('workstack_get_wiki_article', { project: project.name, slug: 'handoff' })).resolves.toEqual({
      article: { slug: 'handoff', content: 'Use the current worktree and preserve its branch.' }
    })

    const claimed = await tools.call('workstack_claim_work_item', {
      project_id: project.id,
      work_item_id: workItem.displayId,
      agent_id: 'codex',
      agent_display_name: 'Codex',
      session_id: 'mcp-session'
    }) as { claim_token: string }
    expect(claimed.claim_token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const detail = await tools.call('workstack_get_work_item', {
      project_id: project.id,
      work_item_id: workItem.id
    }) as { current_claim: Record<string, unknown> }
    expect(detail.current_claim).toMatchObject({ agentId: 'codex' })
    expect(detail.current_claim).not.toHaveProperty('claimToken')
    await expect(tools.call('workstack_get_work_item_handoff', {
      project_id: project.id,
      work_item_id: workItem.id
    })).resolves.toMatchObject({
      work_item: { id: workItem.id },
      current_claim: { agentId: 'codex' },
      completion: undefined
    })

    await expect(
      tools.call('workstack_complete_work_item', {
        project_id: project.id,
        work_item_id: workItem.displayId,
        claim_token: claimed.claim_token,
        completion: { summary_markdown: 'Implemented the MCP contract.', validation_markdown: 'Contract test passed.' }
      })
    ).resolves.toMatchObject({ completed: true, work_item_id: workItem.displayId })
    await expect(tools.call('workstack_search_completed', {
      project_id: project.id,
      query: 'Contract test passed'
    })).resolves.toMatchObject({ work_items: [expect.objectContaining({ id: workItem.id })] })
  })

  it('returns stable validation and ownership errors to the MCP caller', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-mcp-errors-'))
    cleanupPaths.push(directory)
    const projects = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
    const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'MCP Project' })
    const workItem = await projects.createWorkItem(project.id, { title: 'Validate errors' })
    const tools = new WorkstackMcpTools(projects)

    await expect(tools.call('workstack_claim_work_item', {
      project_id: project.id,
      work_item_id: workItem.id,
      agent_id: 'codex'
    })).resolves.toMatchObject({ claimed: true })
    await expect(
      tools.call('workstack_heartbeat_work_item', {
        project_id: project.id,
        work_item_id: workItem.id,
        claim_token: 'wrong-token'
      })
    ).rejects.toMatchObject({ code: 'CLAIM_TOKEN_INVALID' })
    await expect(tools.call('workstack_get_work_item', {
      project_id: project.id,
      work_item_id: 'MCP-999'
    })).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_FOUND' })
    await expect(tools.call('workstack_list_backlog', { project_id: 'not-a-uuid' })).rejects.toThrow()
  })
})
