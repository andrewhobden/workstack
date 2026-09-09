import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkstackError } from '../../src/core/errors'
import { ProjectStore } from '../../src/core/project-store'
import { WikiAutomationRepository } from '../../src/core/wiki-automation'
import { WikiRevisionRepository } from '../../src/core/wiki-revisions'
import { AiRequestError, OpenAiCompatibleProvider } from '../../src/main/ai-provider'
import { WikiAutomationService } from '../../src/main/wiki-automation-service'

vi.mock('electron', () => ({ safeStorage: {} }))

const roots: string[] = []
const start = new Date('2026-09-09T06:00:00.000Z')
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(start) })
afterEach(async () => { vi.useRealTimers(); vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function fixture(provider: { propose(prompt: string, options?: { signal?: AbortSignal }): Promise<string> }) {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-retry-policy-')); roots.push(rootPath)
  const store = await ProjectStore.initialize({ rootPath, name: 'Retry policy' })
  const job = new WikiAutomationRepository(store).createJob({ title: 'Document the project', promptMarkdown: 'Use current project evidence.' })
  const project = store.project
  store.close()
  const service = new WikiAutomationService({ getProject: async () => project } as never, provider as never)
  const process = () => (service as unknown as { processProject(projectId: string): Promise<void> }).processProject(project.id)
  const inspect = async () => {
    const opened = await ProjectStore.open(rootPath)
    try {
      return { job: new WikiAutomationRepository(opened).getJob(job.id), proposals: new WikiRevisionRepository(opened).list(),
        row: opened.database.prepare('SELECT owner,lease_expires_at,next_attempt_at FROM wiki_automation_jobs WHERE id = ?').get(job.id) as { owner: string | null; lease_expires_at: string | null; next_attempt_at: string | null } }
    } finally { opened.close() }
  }
  const retry = async () => {
    const opened = await ProjectStore.open(rootPath)
    try { new WikiAutomationRepository(opened).retryJob(job.id) } finally { opened.close() }
  }
  return { rootPath, process, inspect, retry }
}

describe('durable wiki provider retry policy', () => {
  it.each([
    ['authentication', new AiRequestError('AUTHENTICATION', 'password=private-value', 401)],
    ['invalid response', new AiRequestError('INVALID_RESPONSE', 'password=private-value')],
    ['cancellation', new AiRequestError('CANCELLED', 'password=private-value')],
    ['permanent provider status', new AiRequestError('PROVIDER_ERROR', 'password=private-value', 400)],
    ['validation', new WorkstackError('VALIDATION_ERROR', 'password=private-value')],
    ['unknown error', new Error('password=private-value')],
    ['non-Error failure', 'password=private-value']
  ])('leaves %s failures stopped across reopen until an explicit retry', async (_name, failure) => {
    let healthy = false
    const propose = vi.fn(async () => { if (!healthy) throw failure; return '# Reviewed project evidence' })
    const task = await fixture({ propose })
    await task.process()
    expect(await task.inspect()).toMatchObject({ job: { status: 'failed', attemptCount: 1, errorMessage: 'password=[REDACTED]' }, proposals: [], row: { owner: null, lease_expires_at: null, next_attempt_at: null } })
    vi.setSystemTime(new Date(start.getTime() + 4_000_000))
    await task.process()
    expect(propose).toHaveBeenCalledOnce()
    healthy = true
    await task.retry()
    await task.process()
    const recovered = await task.inspect()
    expect(recovered).toMatchObject({ job: { status: 'completed', attemptCount: 1 }, row: { owner: null, lease_expires_at: null, next_attempt_at: null } })
    expect(recovered.proposals).toHaveLength(1)
    expect(propose).toHaveBeenCalledTimes(5)
  })

  it.each([
    ['rate limit', new AiRequestError('RATE_LIMIT', 'Provider is busy.', 429, true)],
    ['transport or capacity', new AiRequestError('PROVIDER_ERROR', 'Provider is unavailable.', 503, true)]
  ])('backs off %s failures, caps automatic attempts and permits manual recovery', async (_name, failure) => {
    let healthy = false
    const propose = vi.fn(async () => { if (!healthy) throw failure; return '# Recovered project evidence' })
    const task = await fixture({ propose })
    let now = start.getTime()
    for (let attempt = 1; attempt <= 5; attempt++) {
      await task.process()
      const failed = await task.inspect()
      const next = attempt < 5 ? new Date(now + 30_000 * 2 ** (attempt - 1)).toISOString() : null
      expect(failed).toMatchObject({ job: { status: 'failed', attemptCount: attempt }, proposals: [], row: { owner: null, lease_expires_at: null, next_attempt_at: next } })
      await task.process()
      expect(propose).toHaveBeenCalledTimes(attempt)
      now = next ? Date.parse(next) : now + 4_000_000
      vi.setSystemTime(new Date(now))
    }
    await task.process()
    expect(propose).toHaveBeenCalledTimes(5)
    healthy = true
    await task.retry()
    await task.process()
    expect(await task.inspect()).toMatchObject({ job: { status: 'completed', attemptCount: 1 }, row: { owner: null, lease_expires_at: null, next_attempt_at: null } })
    expect(propose).toHaveBeenCalledTimes(9)
  })

  it('persists a bounded provider timeout, releases ownership and resumes after its backoff', async () => {
    const settingsRoot = await mkdtemp(path.join(os.tmpdir(), 'workstack-wiki-timeout-provider-')); roots.push(settingsRoot)
    const settingsPath = path.join(settingsRoot, 'provider.json')
    await writeFile(settingsPath, JSON.stringify({ baseUrl: 'http://localhost:1234/v1', model: 'fixture', apiMode: 'chat_completions' }))
    const provider = new OpenAiCompatibleProvider(settingsPath, { timeoutMs: 20, maxRetries: 0 })
    const fetch = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetch)
    const task = await fixture(provider)
    await task.process()
    expect(await task.inspect()).toMatchObject({ job: { status: 'failed', attemptCount: 1, errorMessage: expect.stringContaining('timed out') }, proposals: [], row: { owner: null, lease_expires_at: null, next_attempt_at: new Date(start.getTime() + 30_000).toISOString() } })
    await task.process()
    expect(fetch).toHaveBeenCalledOnce()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '# Recovered documentation' } }] }))))
    vi.setSystemTime(new Date(start.getTime() + 30_000))
    await task.process()
    expect(await task.inspect()).toMatchObject({ job: { status: 'completed', attemptCount: 2 }, row: { owner: null, lease_expires_at: null, next_attempt_at: null } })
  })

  it('does not resubmit malformed generated articles on future automatic passes', async () => {
    const propose = vi.fn(async () => '<!-- workstack-update:untrusted-marker -->')
    const task = await fixture({ propose })
    await task.process()
    expect(await task.inspect()).toMatchObject({ job: { status: 'failed', attemptCount: 1, errorMessage: expect.stringContaining('invalid') }, proposals: [], row: { owner: null, lease_expires_at: null, next_attempt_at: null } })
    vi.setSystemTime(new Date(start.getTime() + 4_000_000))
    await task.process()
    expect(propose).toHaveBeenCalledOnce()
  })
})
