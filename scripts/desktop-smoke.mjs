import { _electron as electron } from 'playwright'
import electronExecutable from 'electron'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const output = path.resolve(process.env.WORKSTACK_SMOKE_OUTPUT ?? 'test-results/desktop-smoke')
await mkdir(output, { recursive: true })
const temporary = await mkdtemp(path.join(tmpdir(), 'workstack-desktop-smoke-'))
const userData = path.join(temporary, 'user-data')
await mkdir(userData)
const executablePath = process.env.WORKSTACK_SMOKE_EXECUTABLE ?? electronExecutable
const packaged = Boolean(process.env.WORKSTACK_SMOKE_EXECUTABLE)
const args = packaged ? [] : [path.resolve('.')]
const artifact = packaged
  ? path.resolve(path.dirname(executablePath), '../Resources/app.asar')
  : path.resolve('out/main/index.js')
const excludedEnvironment = new Set(['ELECTRON_RUN_AS_NODE', 'ELECTRON_RENDERER_URL'])
const env = Object.fromEntries(Object.entries({ ...process.env, WORKSTACK_USER_DATA_DIR: userData }).filter(([key, value]) => value !== undefined && !excludedEnvironment.has(key)))
const result = {
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  workingTree: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim(),
  artifact, packaged, artifactSha256: createHash('sha256').update(await readFile(artifact)).digest('hex'),
  executablePath, startedAt: new Date().toISOString(), passed: false
}
let app
let page
let log = ''
const launch = async (name) => {
  app = await electron.launch({ executablePath, args, env, timeout: 30_000 })
  app.process().stderr?.on('data', (data) => { log += data.toString() })
  await app.context().tracing.start({ screenshots: true, snapshots: true })
  page = await app.firstWindow()
  page.setDefaultTimeout(30_000)
  page.on('console', (message) => { log += `[${name}] ${message.type()}: ${message.text()}\n` })
  page.on('pageerror', (error) => { log += `[${name}] ${error.stack}\n` })
  await page.waitForURL((url) => url.protocol === 'file:')
  await page.waitForFunction(() => Boolean(window.workstack))
  result.rendererUrls = { ...result.rendererUrls, [name]: page.url() }
}
try {
  await launch('initial')
  await page.getByRole('button', { name: '+ New Project' }).first().click()
  await page.getByLabel('Project name').fill('Desktop smoke')
  await page.getByLabel('Project folder').fill(path.join(temporary, 'project'))
  await page.getByRole('button', { name: 'Create Project', exact: true }).click()
  await page.getByRole('button', { name: 'Backlog', exact: true }).first().click()
  await page.getByRole('button', { name: '+ New Work Item' }).click()
  await page.getByLabel('Work item title').fill('Created in Electron')
  await page.getByRole('button', { name: 'Add to Backlog' }).click()
  await page.getByText('Created in Electron', { exact: true }).click()
  await page.getByRole('button', { name: 'Edit', exact: true }).click()
  await page.getByLabel('Work item title').fill('Edited in Electron')
  await page.getByRole('button', { name: 'Save changes' }).click()
  await page.getByRole('heading', { name: 'Edited in Electron' }).waitFor()
  const identifiers = await page.evaluate(async () => {
    const api = window.workstack
    const [project] = await api.projects.list()
    const [item] = await api.workItems.list(project.id)
    const attachment = await api.attachments.attachBytes(project.id, item.id, { data: new Uint8Array([65, 66, 67]), originalFilename: 'evidence.txt', mimeType: 'text/plain' })
    const proposal = await api.planning.create(project.id)
    await api.planning.update(project.id, proposal.planningSessionId, { title: 'Converted in Electron', descriptionMarkdown: 'Reviewable plan' })
    const converted = await api.planning.convert(project.id, proposal.planningSessionId)
    const source = await api.knowledge.addSource(project.id, { displayName: 'Smoke architecture', filename: 'smoke-architecture.md', content: '# Smoke architecture\n\nEvery smoke task uses a retained revision.\n' })
    await api.sourceCatalog.list(project.id)
    const policy = await api.contextPackets.policy(project.id)
    await api.contextPackets.updatePolicy(project.id, { expectedVersion: policy.version, requirements: [{ category: 'purpose', severity: 'soft' }], sourcePins: [{ sourceId: source.id, category: 'architecture' }], requiredRecordIds: [], allowSoftOverride: true, tokenBudget: 8000, operatorInstructions: 'Preserve the retained revision.' })
    const first = await api.contextPackets.preview(project.id, item.id)
    if (first.canExecute || !first.gaps.some((gap) => gap.category === 'purpose' && gap.severity === 'soft')) throw new Error('Real context preview did not expose its reviewable purpose gap.')
    const packet = await api.contextPackets.preview(project.id, item.id, { packetId: first.id, softOverrideReason: 'The smoke fixture owner reviewed this temporary project purpose.' })
    const section = await api.contextPackets.readSection(project.id, packet.id, 'architecture')
    const sourceCitation = section.citations.find((entry) => entry.sourceId === source.id)
    if (!packet.canExecute || !section.text.includes('Required source: Smoke architecture') || !sourceCitation) throw new Error(`Real context review failed: ${JSON.stringify({ canExecute: packet.canExecute, gaps: packet.gaps, section })}`)
    const revision = await api.sourceCatalog.readRevision(project.id, source.id, sourceCitation.revisionId, 'normalized')
    const citation = await api.sourceCatalog.readCitation(project.id, sourceCitation)
    if (!revision.text.includes('Every smoke task uses a retained revision.') || citation.passage.text !== revision.text.slice(sourceCitation.startOffset, sourceCitation.endOffset)) throw new Error('Real retained revision or exact citation reader disagrees with the packet.')
    const feedback = await api.contextFeedback.create(project.id, { workItemId: item.id, packetId: packet.id, category: 'citation', note: 'Record this retained revision in a smoke evaluation fixture.', sourceIds: [source.id], actor: 'desktop-smoke', authorKind: 'human' })
    const reviewed = await api.contextFeedback.triage(project.id, feedback.id, { expectedVersion: feedback.version, status: 'triaged', action: 'fixture', target: 'desktop-context-smoke', actor: 'desktop-smoke-reviewer', note: 'The retained citation is reviewable after restart.' })
    if (reviewed.status !== 'triaged' || (await api.contextFeedback.history(project.id, feedback.id)).length !== 2) throw new Error('Real context feedback audit was not saved.')
    return { projectId: project.id, projectName: project.name, itemId: item.id, attachmentId: attachment.id, convertedId: converted.id, packetId: packet.id, firstPacketId: first.id, sourceId: source.id, sourceCitation, sourceText: revision.text, sectionText: section.text, feedbackId: feedback.id, launchMarkdown: packet.launchMarkdown }
  })
  await app.context().tracing.stop({ path: path.join(output, 'initial.zip') })
  await app.close()
  app = undefined
  await launch('restart')
  const persisted = await page.evaluate(async (ids) => {
    const api = window.workstack
    return {
      title: (await api.workItems.get(ids.projectId, ids.itemId)).title,
      convertedTitle: (await api.workItems.get(ids.projectId, ids.convertedId)).title,
      attachment: await api.attachments.previewUrl(ids.projectId, ids.itemId, ids.attachmentId),
      packet: await api.contextPackets.get(ids.projectId, ids.packetId),
      packetHistory: await api.contextPackets.list(ids.projectId, ids.itemId),
      section: await api.contextPackets.readSection(ids.projectId, ids.packetId, 'architecture'),
      sourceRevision: await api.sourceCatalog.readRevision(ids.projectId, ids.sourceId, ids.sourceCitation.revisionId, 'normalized'),
      sourceCitation: await api.sourceCatalog.readCitation(ids.projectId, ids.sourceCitation),
      feedback: await api.contextFeedback.list(ids.projectId, { packetId: ids.packetId }),
      feedbackHistory: await api.contextFeedback.history(ids.projectId, ids.feedbackId)
    }
  }, identifiers)
  if (persisted.title !== 'Edited in Electron' || persisted.convertedTitle !== 'Converted in Electron' || persisted.attachment !== 'data:text/plain;base64,QUJD') throw new Error(`Restart persistence mismatch: ${JSON.stringify(persisted)}`)
  if (persisted.packet.launchMarkdown !== identifiers.launchMarkdown || persisted.packet.previousPacketId !== identifiers.firstPacketId || persisted.packetHistory.length !== 2 || persisted.section.text !== identifiers.sectionText || persisted.sourceRevision.text !== identifiers.sourceText || persisted.sourceCitation.passage.text !== identifiers.sourceText.slice(identifiers.sourceCitation.startOffset, identifiers.sourceCitation.endOffset) || persisted.feedback[0]?.status !== 'triaged' || persisted.feedbackHistory.length !== 2) throw new Error('Packet, history, exact section, retained source revision/citation or feedback changed across native application restart.')
  result.context = { packetId: identifiers.packetId, packetVersions: persisted.packetHistory.length, retainedCitations: persisted.section.citations.length, feedbackEvents: persisted.feedbackHistory.length }
  await app.context().tracing.stop({ path: path.join(output, 'restart.zip') })
  await app.close()
  app = undefined
  const transport = new StdioClientTransport({ command: executablePath, args: [...args, '--mcp'], env, stderr: 'pipe' })
  transport.stderr?.on('data', (data) => { log += `[mcp] ${data.toString()}` })
  const client = new Client({ name: 'workstack-artifact-smoke', version: '1.0.0' })
  try {
    await client.connect(transport, { timeout: 15_000 })
    const tools = await client.listTools()
    if (!tools.tools.some((tool) => tool.name === 'workstack_list_projects')) throw new Error('Built artifact MCP tool list is missing workstack_list_projects')
    result.mcpToolCount = tools.tools.length
    const call = async (name, input) => {
      const response = await client.callTool({ name, arguments: input })
      const text = response.content.filter((entry) => entry.type === 'text').map((entry) => entry.text).join('\n')
      if (response.isError) throw new Error(`Built artifact MCP ${name} failed: ${text}`)
      return JSON.parse(text)
    }
    const reference = { project: identifiers.projectName, packet_id: identifiers.packetId }
    const packet = await call('workstack_get_context_packet', reference)
    const section = await call('workstack_read_context_section', { ...reference, category: 'architecture' })
    const revision = await call('workstack_read_source_revision', { project: identifiers.projectName, source_id: identifiers.sourceId, revision_id: identifiers.sourceCitation.revisionId, representation: 'normalized' })
    const citation = await call('workstack_read_source_citation', { project: identifiers.projectName, citation: identifiers.sourceCitation })
    const history = await call('workstack_list_context_packets', { project: identifiers.projectName, work_item_id: identifiers.itemId })
    const artifact = await call('workstack_read_context_artifact', { ...reference, artifact_id: identifiers.attachmentId })
    if (packet.id !== identifiers.packetId || packet.launchMarkdown !== identifiers.launchMarkdown || section.text !== identifiers.sectionText || revision.text !== identifiers.sourceText || citation.passage.text !== revision.text.slice(identifiers.sourceCitation.startOffset, identifiers.sourceCitation.endOffset) || history.packets.length !== 2 || artifact.dataBase64 !== 'QUJD') throw new Error('Built artifact MCP disagrees with the exact native desktop context, full source revision/citation or attachment.')
    result.mcpContextVerified = true
  } finally {
    await client.close()
  }
  result.passed = true
} catch (error) {
  result.error = error.stack ?? String(error)
  if (page && !page.isClosed()) await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {})
  if (app) await app.context().tracing.stop({ path: path.join(output, 'failure.zip') }).catch(() => {})
  process.exitCode = 1
} finally {
  if (app) await app.close().catch(() => {})
  result.finishedAt = new Date().toISOString()
  await writeFile(path.join(output, 'result.json'), JSON.stringify(result, null, 2))
  await writeFile(path.join(output, 'desktop.log'), log)
  await rm(temporary, { recursive: true, force: true })
  console.log(JSON.stringify(result, null, 2))
}
