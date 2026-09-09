import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MCP_TOOL_NAMES, WorkstackMcpTools } from '../../src/mcp/server'
import { ProjectRegistry } from '../../src/core/project-registry'
import { ProjectsService } from '../../src/core/projects-service'
import { ProjectStore } from '../../src/core/project-store'
import { WorkItemRepository } from '../../src/core/work-items'

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
      'workstack_preview_context_packet',
      'workstack_get_context_packet',
      'workstack_list_context_packets',
      'workstack_read_context_section',
      'workstack_read_context_artifact',
      'workstack_list_project_sources',
      'workstack_read_source_revision',
      'workstack_read_source_citation',
      'workstack_report_context_feedback',

      'workstack_search_knowledge',
      'workstack_list_backlog',
      'workstack_create_work_item',
      'workstack_create_feature',
      'workstack_create_bug',
      'workstack_search_completed',
      'workstack_get_work_item',
      'workstack_get_work_item_handoff',
      'workstack_get_task_coordination',
      'workstack_update_task_coordination',
      'workstack_query_evidence_graph',
      'workstack_list_knowledge_records',
      'workstack_get_knowledge_record',
      'workstack_check_knowledge_records',
      'workstack_lookup_project_directory',
      'workstack_get_project_entity',
      'workstack_save_checkpoint',
      'workstack_list_checkpoints',
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
      mode: 'lexical', fallback_reason: 'No local semantic model is enabled.', corpus_revision: expect.stringMatching(/^[a-f0-9]{64}$/), config_fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), truncated: false,
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

  it('resolves an old display ID through handoff and ownership tools and reports submission separately from merge', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-mcp-old-id-'))
    cleanupPaths.push(directory)
    const projects = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
    const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'Old task fixture' })
    const store = await ProjectStore.open(project.rootPath)
    const repository = new WorkItemRepository(store)
    const oldest = repository.create({ title: 'Oldest launchable item' })
    for (let index = 0; index < 105; index++) repository.create({ title: `Newer item ${index}` })
    store.close()
    const tools = new WorkstackMcpTools(projects)
    const reference = { project: project.name, work_item_id: oldest.displayId }
    await expect(tools.call('workstack_get_work_item', reference)).resolves.toMatchObject({ work_item: { id: oldest.id } })
    const claimed = await tools.call('workstack_claim_work_item', { ...reference, agent_id: 'copilot', session_id: 'old-item-session', requested_lease_seconds: 60 }) as { claim_token: string; recommended_heartbeat_seconds: number }
    expect(claimed.recommended_heartbeat_seconds).toBeLessThan(60)
    await expect(tools.call('workstack_heartbeat_work_item', { ...reference, claim_token: claimed.claim_token })).resolves.toHaveProperty('lease_expires_at')
    await tools.call('workstack_save_checkpoint', { ...reference, claim_token: claimed.claim_token, progress_markdown: 'Partial parser implementation', files_changed: ['src/parser.ts'], validation_markdown: 'Parser tests pass', next_actions_markdown: 'Review edge cases' })
    await tools.call('workstack_block_work_item', { ...reference, claim_token: claimed.claim_token, retain_claim: true, reason: 'Pending review' })
    await expect(tools.call('workstack_get_work_item_handoff', { ...reference, work_item_id: oldest.id })).resolves.toMatchObject({
      work_item: { id: oldest.id }, latest_checkpoint: { agentId: 'copilot', sessionId: 'old-item-session', progressMarkdown: 'Partial parser implementation' }, completion_history: []
    })
    await tools.call('workstack_release_work_item', { ...reference, claim_token: claimed.claim_token, reason: 'Pause' })
    await expect(tools.call('workstack_list_checkpoints', reference)).resolves.toMatchObject({ checkpoints: [{ progressMarkdown: 'Partial parser implementation' }] })
    await expect(tools.call('workstack_save_checkpoint', { ...reference, claim_token: claimed.claim_token, progress_markdown: 'Old writer' })).rejects.toMatchObject({ code: 'CLAIM_TOKEN_INVALID' })
    const next = await tools.call('workstack_claim_work_item', { ...reference, agent_id: 'next' }) as { claim_token: string }
    const prUrl = 'https://github.com/acme/workstack/pull/1001'
    const result = await tools.call('workstack_complete_work_item', { ...reference, claim_token: next.claim_token, completion: { summary_markdown: 'Ready for delivery', pr_url: prUrl } })
    expect(result).toMatchObject({ completed: false, submitted: true, submitted_at: expect.any(String), completed_at: null, delivery_state: 'awaiting_review' })
    await projects.reconcilePullRequestWorkItem(project.id, oldest.id, prUrl, 'MERGED')
    await expect(tools.call('workstack_get_work_item', reference)).resolves.toMatchObject({ work_item: { status: 'completed', deliveryState: 'merged', completedAt: expect.any(String) } })
  })

  it('keeps completion-only terms searchable through all metadata edits', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-mcp-search-edits-'))
    cleanupPaths.push(directory)
    const projects = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
    const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'Search edits' })
    const item = await projects.createWorkItem(project.id, { title: 'Original title' })
    const tools = new WorkstackMcpTools(projects)
    const claim = await tools.call('workstack_claim_work_item', { project: project.name, work_item_id: item.displayId, agent_id: 'worker' }) as { claim_token: string }
    await tools.call('workstack_complete_work_item', { project: project.name, work_item_id: item.displayId, claim_token: claim.claim_token, completion: { summary_markdown: 'Unique completion evidence', validation_markdown: 'Test quorum intact' } })
    for (const patch of [{ title: 'Changed title' }, { descriptionMarkdown: 'Changed description' }, { acceptanceCriteriaMarkdown: 'Changed criteria' }, { priority: 'high' as const }, { type: 'bug' as const }]) {
      await projects.updateWorkItem(project.id, item.id, patch)
      await expect(tools.call('workstack_search_completed', { project: project.name, query: 'quorum intact' })).resolves.toMatchObject({ work_items: [{ id: item.id }] })
    }
    for (const query of ['Changed title', 'Changed description', 'Changed criteria']) {
      await expect(tools.call('workstack_search_completed', { project: project.name, query })).resolves.toMatchObject({ work_items: [{ id: item.id }] })
    }
  })

  it('exposes readiness, prerequisite outcomes and advisory worker identities through coordination tools and handoff', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'workstack-mcp-dependencies-'))
    cleanupPaths.push(directory)
    const projects = new ProjectsService(new ProjectRegistry(path.join(directory, 'registry.json')))
    const project = await projects.createProject({ rootPath: path.join(directory, 'project'), name: 'Dependencies' })
    const task = await projects.createWorkItem(project.id, { title: 'Use API' })
    const prerequisite = await projects.createWorkItem(project.id, { title: 'Build API' })
    const overlapping = await projects.createWorkItem(project.id, { title: 'API documentation' })
    const tools = new WorkstackMcpTools(projects)
    await tools.call('workstack_update_task_coordination', {
      project: project.name, work_item_id: task.displayId, depends_on: [prerequisite.displayId], related_to: [overlapping.id], declared_paths: ['src/api'], declared_components: ['api']
    })
    await expect(tools.call('workstack_list_backlog', { project: project.name })).resolves.toMatchObject({ work_items: expect.arrayContaining([
      { id: task.id, displayId: task.displayId, type: 'feature', title: 'Use API', priority: 'normal', readiness: { ready: false, blockers: [{ workItemId: prerequisite.id, displayId: prerequisite.displayId, reason: 'Task is backlog.' }] } }
    ]) })
    await expect(tools.call('workstack_claim_work_item', { project: project.name, work_item_id: task.id, agent_id: 'consumer' })).rejects.toMatchObject({ code: 'WORK_ITEM_NOT_CLAIMABLE' })
    const claim = await projects.claimWorkItem(project.id, prerequisite.id, { agentId: 'prerequisite-worker' })
    await projects.completeWorkItem(project.id, prerequisite.id, claim.claimToken, { summaryMarkdown: 'API ready', commitSha: 'c'.repeat(40) })
    await projects.updateTaskCoordination(project.id, overlapping.id, { declaredPaths: ['src/api/docs.ts'] })
    await projects.claimWorkItem(project.id, overlapping.id, { agentId: 'documentation-worker', sessionId: 'docs-session' })
    await expect(tools.call('workstack_get_task_coordination', { project: project.name, work_item_id: task.displayId })).resolves.toMatchObject({ coordination: {
      readiness: { ready: true }, prerequisites: [{ outcome: { completion: { summaryMarkdown: 'API ready', commitSha: 'c'.repeat(40) } } }],
      activeOverlaps: [{ workItemId: overlapping.id, agentId: 'documentation-worker', sessionId: 'docs-session', advisory: true }]
    } })
    await expect(tools.call('workstack_get_work_item_handoff', { project: project.name, work_item_id: task.id })).resolves.toMatchObject({ coordination: {
      readiness: { ready: true }, related: [{ workItemId: overlapping.id }], activeOverlaps: [{ agentId: 'documentation-worker' }]
    } })
    await tools.call('workstack_update_task_coordination', { project: project.name, work_item_id: task.id, depends_on: [], related_to: [], declared_paths: [], declared_components: [] })
    await expect(tools.call('workstack_get_task_coordination', { project: project.name, work_item_id: task.id })).resolves.toMatchObject({ coordination: { prerequisites: [], related: [], declaredPaths: [], declaredComponents: [], activeOverlaps: [] } })
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
