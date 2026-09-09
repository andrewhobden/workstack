import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { WorkstackError } from '../core/errors'
import { excludedEvidencePath, redactEvidence } from '../core/evidence-policy'
import { ProjectStore } from '../core/project-store'
import { ProjectsService } from '../core/projects-service'
import { SourceCatalogRepository, type ProjectSource, type SourceAcquirer, type SourceAcquisition } from '../core/source-catalog'
import { hashSourceText } from '../core/source-passages'
import type { KnowledgeIntakeJob } from '../core/knowledge-jobs'
import type { SourceImportSelection, SourceIntakeLimits, SourceInventory, SourceInventoryEntry } from '../core/source-intake-types'

export const SOURCE_INTAKE_LIMITS: SourceIntakeLimits = {
  maxInventoryFiles: 500, maxFiles: 40, maxFileBytes: 250_000, maxTotalBytes: 4_000_000,
  maxGithubSources: 10, maxGithubComments: 200, maxGithubPages: 3, maxTextCharacters: 500_000
}
type RunSourceCommand = (command: 'git' | 'gh', args: string[], cwd: string, options?: { maxBytes?: number; signal?: AbortSignal }) => Promise<string>
interface GithubTarget { owner: string; repository: string; kind: 'github_issue' | 'github_pr' | 'github_file'; number?: number; ref?: string; filePath?: string; canonicalUrl: string }
type JsonObject = Record<string, unknown>

export class SourceIntakeService {
  private readonly active = new Map<string, Promise<void>>()
  private timer?: NodeJS.Timeout
  private readonly run: RunSourceCommand
  constructor(private readonly projects: ProjectsService, dependencies: { run?: RunSourceCommand } = {}) { this.run = dependencies.run ?? runSourceCommand }

  async previewRepository(projectId: string): Promise<SourceInventory> {
    return this.projects.withProjectOperation(projectId, async () => {
      const project = await this.projects.getProject(projectId)
      const diagnostics: string[] = []
      let commit: string | undefined
      try { commit = (await this.run('git', ['rev-parse', '--verify', 'HEAD'], project.rootPath)).trim() } catch { diagnostics.push('No committed HEAD is available; imported working files will be identified by content hash.') }
      let paths: string[]
      try { paths = [...new Set((await this.run('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], project.rootPath, { maxBytes: 2_000_000 })).split('\0').filter(Boolean))].sort() }
      catch (error) { return { entries: [], commit, limited: false, diagnostics: [...diagnostics, redactEvidence(error instanceof Error ? error.message : String(error))], limits: { ...SOURCE_INTAKE_LIMITS } } }
      const limited = paths.length > SOURCE_INTAKE_LIMITS.maxInventoryFiles
      if (limited) diagnostics.push(`Only the first ${SOURCE_INTAKE_LIMITS.maxInventoryFiles} inventory paths are shown. Import a narrower selection.`)
      const entries: SourceInventoryEntry[] = []
      for (const relativePath of paths.slice(0, SOURCE_INTAKE_LIMITS.maxInventoryFiles)) {
        const kind = classifyFile(relativePath)
        let excludedReason = excludedPathReason(relativePath)
        let sizeBytes = 0
        try {
          const filename = await selectedFilePath(project.rootPath, relativePath)
          const info = await fs.stat(filename)
          sizeBytes = info.size
          if (sizeBytes > SOURCE_INTAKE_LIMITS.maxFileBytes) excludedReason ??= `File exceeds ${SOURCE_INTAKE_LIMITS.maxFileBytes} bytes.`
          if (!excludedReason) {
            const handle = await fs.open(filename, 'r')
            try { const sample = Buffer.alloc(Math.min(4096, sizeBytes)); await handle.read(sample, 0, sample.length, 0); if (sample.includes(0)) excludedReason = 'Binary content is unsupported.' } finally { await handle.close() }
          }
        } catch (error) { excludedReason ??= error instanceof Error ? error.message : String(error) }
        entries.push({ path: relativePath, kind, sizeBytes, suggested: !excludedReason && (kind === 'documentation' || kind === 'configuration'), ...(excludedReason ? { excludedReason } : {}) })
      }
      return { entries, commit, limited, diagnostics, limits: { ...SOURCE_INTAKE_LIMITS } }
    })
  }

  async importSelection(projectId: string, selection: SourceImportSelection): Promise<KnowledgeIntakeJob[]> {
    const input = z.object({ paths: z.array(z.string().min(1)).max(SOURCE_INTAKE_LIMITS.maxFiles), githubUrls: z.array(z.string().url()).max(SOURCE_INTAKE_LIMITS.maxGithubSources).default([]), policy: z.enum(['import_once', 'tracked_content', 'metadata_only', 'paused']).default('import_once'), workItemId: z.string().optional() }).parse(selection)
    if (!input.paths.length && !input.githubUrls.length) throw new WorkstackError('VALIDATION_ERROR', 'Select at least one repository or GitHub source.')
    if (input.policy === 'paused') throw new WorkstackError('VALIDATION_ERROR', 'Choose an active intake policy, then pause the source after importing if needed.')
    const queued = await this.projects.withProjectOperation(projectId, async () => {
      const project = await this.projects.getProject(projectId)
      if (input.workItemId) await this.projects.getWorkItem(projectId, input.workItemId)
      const preview = await this.previewRepository(projectId)
      const candidates = new Map(preview.entries.map((entry) => [entry.path, entry]))
      const chosen = [...new Set(input.paths)].map((relativePath) => {
        const entry = candidates.get(relativePath)
        if (!entry || entry.excludedReason) throw new WorkstackError('VALIDATION_ERROR', `Source ${relativePath} was excluded or is outside the displayed inventory. ${entry?.excludedReason ?? ''}`)
        return entry
      })
      if (chosen.reduce((size, entry) => size + entry.sizeBytes, 0) > SOURCE_INTAKE_LIMITS.maxTotalBytes) throw new WorkstackError('VALIDATION_ERROR', `Selected files exceed the ${SOURCE_INTAKE_LIMITS.maxTotalBytes}-byte batch limit.`)
      const remote = [...new Set(input.githubUrls)].map(parseGithubTarget)
      const store = await ProjectStore.open(project.rootPath)
      try {
        const catalog = new SourceCatalogRepository(store)
        return store.database.transaction(() => {
          const jobs: KnowledgeIntakeJob[] = []
          for (const entry of chosen) {
            const source = catalog.registerSource({ kind: 'repo_file', title: entry.path, canonicalUri: `repo://${project.id}/${entry.path.split('/').map(encodeURIComponent).join('/')}`, repositoryPath: entry.path, policy: input.policy, workItemId: input.workItemId })
            if (source.policy !== input.policy) catalog.updatePolicy(source.id, input.policy)
            jobs.push(catalog.queueImport(source.id, `source-selection:${source.id}:${randomUUID()}`, { maxSelectedBytes: entry.sizeBytes }))
          }
          for (const target of remote) {
            const source = catalog.registerSource({ kind: target.kind, title: target.canonicalUrl, canonicalUri: target.canonicalUrl, policy: input.policy, workItemId: input.workItemId })
            if (source.policy !== input.policy) catalog.updatePolicy(source.id, input.policy)
            jobs.push(catalog.queueImport(source.id, `source-selection:${source.id}:${randomUUID()}`))
          }
          return jobs
        }).immediate()
      } finally { store.close() }
    })
    void this.processProject(projectId).catch((error) => this.report(error))
    return queued
  }

  async refresh(projectId: string, sourceId: string): Promise<KnowledgeIntakeJob> {
    const job = await this.projects.withProjectOperation(projectId, async () => {
      const project = await this.projects.getProject(projectId)
      const store = await ProjectStore.open(project.rootPath)
      try { return new SourceCatalogRepository(store).queueImport(sourceId, `source-manual-refresh:${sourceId}:${randomUUID()}`) } finally { store.close() }
    })
    void this.processProject(projectId).catch((error) => this.report(error))
    return job
  }

  processProject(projectId: string): Promise<void> {
    const existing = this.active.get(projectId)
    if (existing) return existing
    const processing = this.projects.withProjectOperation(projectId, async () => {
      const project = await this.projects.getProject(projectId)
      const store = await ProjectStore.open(project.rootPath)
      try {
        const catalog = new SourceCatalogRepository(store)
        catalog.scheduleDue()
        for (let count = 0; count < 100; count += 1) {
          const job = await catalog.processNext((source, options) => this.acquire(source, options, project.rootPath, catalog))
          if (!job) break
        }
        await this.projects.processSemanticJobs(projectId)
      } finally { store.close() }
    }).finally(() => this.active.delete(projectId))
    this.active.set(projectId, processing)
    return processing
  }
  start(): void {
    if (this.timer) return
    void this.catchUp()
    this.timer = setInterval(() => { void this.catchUp() }, 60_000)
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined }
  private async catchUp(): Promise<void> {
    try { await Promise.all((await this.projects.listProjects()).filter((project) => !project.availability || project.availability === 'available').map((project) => this.processProject(project.id).catch((error) => this.report(error)))) } catch (error) { this.report(error) }
  }
  private report(error: unknown): void { console.error(`[source-intake] ${redactEvidence(error instanceof Error ? error.message : String(error))}`) }

  private async acquire(source: ProjectSource, options: Parameters<SourceAcquirer>[1], rootPath: string, catalog: SourceCatalogRepository): Promise<SourceAcquisition> {
    try {
      if (source.kind === 'repo_file') {
        if (!source.repositoryPath || excludedPathReason(source.repositoryPath)) return { unavailable: true, reason: 'The selected file is excluded from project evidence.', retryable: false }
        const filename = await selectedFilePath(rootPath, source.repositoryPath)
        const info = await fs.stat(filename)
        const fingerprint = `${info.size}:${info.mtimeMs}:${info.ctimeMs}`
        if (options.metadataOnly) {
          const prior = source.currentRevisionId ? catalog.getRevision(source.id, source.currentRevisionId) : undefined
          return { metadataOnly: true, upstreamRevision: prior?.manifest.metadata.fileFingerprint === fingerprint ? prior.upstreamRevision : `metadata:${fingerprint}` }
        }
        const selectedBudget = typeof options.payload.maxSelectedBytes === 'number' ? options.payload.maxSelectedBytes : SOURCE_INTAKE_LIMITS.maxFileBytes
        if (info.size > Math.min(selectedBudget, SOURCE_INTAKE_LIMITS.maxFileBytes)) return { unavailable: true, reason: 'The file grew beyond its selected byte budget. Preview and select it again.', retryable: false }
        const data = await fs.readFile(filename)
        if (data.byteLength > Math.min(selectedBudget, SOURCE_INTAKE_LIMITS.maxFileBytes)) return { unavailable: true, reason: 'File changed beyond its byte budget while being read.', retryable: false }
        const after = await fs.stat(filename)
        if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs) return { unavailable: true, reason: 'File changed while being acquired; retry a stable revision.', retryable: true }
        let commit: string | undefined
        try { commit = (await this.run('git', ['rev-parse', '--verify', 'HEAD'], rootPath, { signal: options.signal })).trim() } catch { /* Content hash still identifies an uncommitted working tree. */ }
        const decoded = decodeSourceBytes(data)
        const original = decoded.original
        if (!decoded.supported) return { original, outcome: 'unsupported', converter: 'binary-preservation', limitations: ['Binary or invalid UTF-8 source retained as base64; no textual conversion was published.'], metadata: { originalEncoding: 'base64', originalByteHash: decoded.byteHash, repositoryPath: source.repositoryPath } }
        return { original, upstreamRevision: `sha256:${hashSourceText(original)}`, acquiredBy: 'selected-repository-import', metadata: { repositoryPath: source.repositoryPath, gitCommit: commit ?? null, workingTree: true, fileFingerprint: fingerprint, byteLength: data.byteLength } }
      }
      if (source.kind.startsWith('github_')) return await this.acquireGithub(parseGithubTarget(source.canonicalUri), rootPath, options)
      return { unavailable: true, reason: 'This source has no tracked acquisition adapter. Import a new manual or published revision explicitly.', retryable: false }
    } catch (error) {
      const message = redactEvidence(error instanceof Error ? error.message : String(error))
      const code = (error as NodeJS.ErrnoException).code
      return { unavailable: true, reason: message, deleted: code === 'ENOENT' || /HTTP 404/.test(message), retryable: !/HTTP (401|403|404)|authentication|not logged in/i.test(message) && code !== 'EACCES' && code !== 'EPERM' }
    }
  }

  private async acquireGithub(target: GithubTarget, cwd: string, options: Parameters<SourceAcquirer>[1]): Promise<SourceAcquisition> {
    const base = `repos/${target.owner}/${target.repository}`
    const request = async (endpoint: string): Promise<unknown> => JSON.parse(await this.run('gh', ['api', endpoint], cwd, { maxBytes: 2_000_000, signal: options.signal }))
    if (options.metadataOnly) {
      const selection = target.kind === 'github_file' ? 'object(expression:$ref){... on Commit{oid} ... on Tag{target{oid}}}'
        : target.kind === 'github_pr' ? 'pullRequest(number:$number){updatedAt headRefOid}' : 'issue(number:$number){updatedAt}'
      const variable = target.kind === 'github_file' ? '$ref:String!' : '$number:Int!'
      const query = `query($owner:String!,$name:String!,${variable}){repository(owner:$owner,name:$name){${selection}}}`
      const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${target.owner}`, '-f', `name=${target.repository}`, ...(target.kind === 'github_file' ? ['-f', `ref=${target.ref}`] : ['-F', `number=${target.number}`])]
      const response = JSON.parse(await this.run('gh', args, cwd, { maxBytes: 100_000, signal: options.signal })) as { data?: { repository?: Record<string, JsonObject> }; errors?: unknown[] }
      if (response.errors?.length || !response.data?.repository) throw new Error('GitHub metadata access failed.')
      const metadata = response.data.repository[target.kind === 'github_file' ? 'object' : target.kind === 'github_pr' ? 'pullRequest' : 'issue']
      if (!metadata) return { unavailable: true, reason: 'GitHub source metadata is unavailable or deleted.', deleted: true, retryable: false }
      const revision = target.kind === 'github_file' ? stringValue(metadata.oid ?? (metadata.target as JsonObject | undefined)?.oid) : `${stringValue(metadata.updatedAt)}:${stringValue(metadata.headRefOid)}`
      if (!revision) throw new Error('GitHub metadata did not identify a source revision.')
      return { metadataOnly: true, upstreamRevision: revision }
    }
    if (target.kind === 'github_file') {
      const resolved = await request(`${base}/commits/${encodeURIComponent(target.ref!)}`) as JsonObject
      const commit = stringValue(resolved.sha)
      if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('GitHub did not return an immutable file revision.')
      const file = await request(`${base}/contents/${target.filePath!.split('/').map(encodeURIComponent).join('/')}?ref=${commit}`) as JsonObject
      if (Number(file.size) > SOURCE_INTAKE_LIMITS.maxFileBytes) return { unavailable: true, reason: `GitHub file exceeds ${SOURCE_INTAKE_LIMITS.maxFileBytes} bytes.`, retryable: false }
      if (file.encoding !== 'base64' || typeof file.content !== 'string') return { unavailable: true, reason: 'GitHub did not return supported file content.', retryable: false }
      const data = Buffer.from(file.content.replace(/\s/g, ''), 'base64')
      if (data.length > SOURCE_INTAKE_LIMITS.maxFileBytes) throw new WorkstackError('VALIDATION_ERROR', 'GitHub content exceeded its declared byte limit.')
      const decoded = decodeSourceBytes(data)
      return { original: decoded.original, upstreamRevision: commit, acquiredBy: 'selected-github-import', outcome: decoded.supported ? 'complete' : 'unsupported', limitations: decoded.supported ? [] : ['Binary or invalid UTF-8 GitHub evidence retained as base64 without conversion.'], metadata: { blobSha: file.sha, resolvedCommit: commit, canonicalRevisionUri: `https://github.com/${target.owner}/${target.repository}/blob/${commit}/${target.filePath}`, originalEncoding: decoded.supported ? 'utf8' : 'base64', originalByteHash: decoded.byteHash } }
    }
    const endpoint = target.kind === 'github_pr' ? `${base}/pulls/${target.number}` : `${base}/issues/${target.number}`
    const document = await request(endpoint) as JsonObject
    const updatedAt = stringValue(document.updated_at)
    const limitations: string[] = []
    const discussion: JsonObject[] = []
    const routes = [`${base}/issues/${target.number}/comments`, ...(target.kind === 'github_pr' ? [`${base}/pulls/${target.number}/reviews`, `${base}/pulls/${target.number}/comments`] : [])]
    for (const route of routes) {
      for (let page = 1; page <= SOURCE_INTAKE_LIMITS.maxGithubPages; page += 1) {
        if (discussion.length >= SOURCE_INTAKE_LIMITS.maxGithubComments) { limitations.push(`Discussion limited to ${SOURCE_INTAKE_LIMITS.maxGithubComments} records; additional comments or reviews were omitted.`); break }
        let entries: JsonObject[]
        try {
          const response = await request(`${route}?per_page=100&page=${page}`)
          if (!Array.isArray(response)) throw new Error('GitHub discussion response was not a list.')
          entries = response as JsonObject[]
        } catch (error) { limitations.push(`Discussion endpoint ${route} was incomplete: ${redactEvidence(error instanceof Error ? error.message : String(error))}`); break }
        const remaining = SOURCE_INTAKE_LIMITS.maxGithubComments - discussion.length
        discussion.push(...entries.slice(0, remaining).map((entry) => ({ ...entry, evidenceKind: route.endsWith('/reviews') ? 'review' : route.includes('/pulls/') ? 'review_comment' : 'comment' })))
        if (entries.length > remaining || entries.length === 100 && page === SOURCE_INTAKE_LIMITS.maxGithubPages) limitations.push('Configured pagination limit reached; discussion completeness is not established.')
        if (entries.length < 100) break
      }
    }
    const renderRecord = (entry: JsonObject) => `### ${stringValue(entry.evidenceKind) || 'body'} ${entry.id ?? ''}\nAuthor: ${stringValue(entry.user && typeof entry.user === 'object' ? (entry.user as JsonObject).login : '') || 'unknown'}\nCreated: ${stringValue(entry.created_at ?? entry.submitted_at)}\nUpdated: ${stringValue(entry.updated_at)}\nURL: ${stringValue(entry.html_url) || target.canonicalUrl}\n${entry.path ? `File: ${stringValue(entry.path)}\n` : ''}\n${stringValue(entry.body)}\n`
    let original = `# ${stringValue(document.title)}\nCanonical URL: ${target.canonicalUrl}\n\n${renderRecord(document)}\n${discussion.map(renderRecord).join('\n')}`
    if (original.length > SOURCE_INTAKE_LIMITS.maxTextCharacters) { original = original.slice(0, SOURCE_INTAKE_LIMITS.maxTextCharacters); limitations.push(`Text limited to ${SOURCE_INTAKE_LIMITS.maxTextCharacters} characters; original upstream discussion is incomplete.`) }
    // Recheck metadata after pagination; mixed upstream revisions are marked partial.
    try { const latest = await request(endpoint) as JsonObject; if (latest.updated_at !== document.updated_at) limitations.push('GitHub source changed during acquisition; refresh again for a coherent upstream revision.') } catch { limitations.push('Could not verify source metadata after discussion pagination.') }
    return { original, upstreamRevision: `${updatedAt}:${stringValue(document.head && typeof document.head === 'object' ? (document.head as JsonObject).sha : '')}`, acquiredBy: 'selected-github-import', outcome: limitations.length ? 'partial' : 'complete', limitations, metadata: { canonicalUrl: target.canonicalUrl, author: (document.user as JsonObject | undefined)?.login ?? null, createdAt: document.created_at ?? null, updatedAt, discussionCount: discussion.length, maxDiscussionRecords: SOURCE_INTAKE_LIMITS.maxGithubComments, complete: limitations.length === 0 } }
  }
}

function classifyFile(filename: string): SourceInventoryEntry['kind'] {
  const base = path.basename(filename).toLowerCase()
  if (/\.(md|mdx|rst|txt|adoc)$/.test(base) || /^(readme|contributing|agents|architecture|license)(\.|$)/.test(base)) return 'documentation'
  if (/\.(json|toml|yaml|yml|ini|cfg)$/.test(base) || /(^makefile$|^dockerfile|config\.[cm]?[jt]s$|^go.mod$|^cargo.lock$)/.test(base)) return 'configuration'
  if (/\.(tsx?|jsx?|[cm]js|py|go|rs|java|kt|swift|c|cpp|h|rb|sh|sql)$/.test(base)) return 'code'
  return 'other'
}
function excludedPathReason(filename: string): string | undefined {
  if (excludedEvidencePath(filename) || filename.startsWith('.workstack-') || filename.split('/').some((part) => ['build', 'vendor', '.venv', '__pycache__'].includes(part))) return 'Excluded credential, dependency, generated or Workstack data path.'
  if (classifyFile(filename) === 'other' || /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/.test(filename) || /\.min\.(js|css)$/.test(filename)) return 'Generated or unsupported evidence format.'
  return undefined
}
async function selectedFilePath(root: string, relative: string): Promise<string> {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..') || relative.includes('\0')) throw new WorkstackError('VALIDATION_ERROR', 'Select a repository-relative file path.')
  const resolvedRoot = await fs.realpath(root)
  const candidate = path.resolve(root, relative)
  const info = await fs.lstat(candidate)
  if (!info.isFile() || info.isSymbolicLink()) throw new WorkstackError('VALIDATION_ERROR', 'Only regular, non-symlink source files can be imported.')
  const resolved = await fs.realpath(candidate)
  const within = path.relative(resolvedRoot, resolved)
  if (within === '..' || within.startsWith(`..${path.sep}`) || path.isAbsolute(within)) throw new WorkstackError('VALIDATION_ERROR', 'Selected source leaves the repository root.')
  return resolved
}
export function parseGithubTarget(input: string): GithubTarget {
  const url = new URL(input)
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search || !/^[\w.-]+$/.test(parts[0] ?? '') || !/^[\w.-]+$/.test(parts[1] ?? '')) throw new WorkstackError('VALIDATION_ERROR', 'Choose an explicit github.com issue, pull request or file URL.')
  const [owner, repository, kind, reference, ...rest] = parts
  if ((kind === 'issues' || kind === 'pull') && /^\d+$/.test(reference ?? '') && !rest.length) return { owner, repository, kind: kind === 'pull' ? 'github_pr' : 'github_issue', number: Number(reference), canonicalUrl: `https://github.com/${owner}/${repository}/${kind}/${reference}` }
  if (kind === 'blob' && reference && rest.length && !excludedPathReason(rest.join('/')) && !rest.includes('..')) return { owner, repository, kind: 'github_file', ref: reference, filePath: rest.join('/'), canonicalUrl: `https://github.com/${owner}/${repository}/blob/${encodeURIComponent(reference)}/${rest.map(encodeURIComponent).join('/')}` }
  throw new WorkstackError('VALIDATION_ERROR', 'Use a supported GitHub file, issue or pull-request URL; credential and generated files are excluded.')
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }

function runSourceCommand(command: 'git' | 'gh', args: string[], cwd: string, options: { maxBytes?: number; signal?: AbortSignal } = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], signal: options.signal })
    const maxBytes = options.maxBytes ?? 100_000
    const stdout: Buffer[] = []
    let size = 0
    let stderr = ''
    let failure: Error | undefined
    const timer = setTimeout(() => { failure = new Error(`${command} source acquisition timed out.`); child.kill('SIGKILL') }, 30_000)
    child.stdout.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) { failure = new Error(`${command} exceeded the source acquisition output limit.`); child.kill('SIGKILL') } else stdout.push(chunk) })
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4000) })
    child.once('error', (error) => { clearTimeout(timer); child.kill('SIGKILL'); reject(error) })
    child.once('close', (code) => { clearTimeout(timer); if (failure || code !== 0) reject(failure ?? new Error(redactEvidence(stderr.trim()) || `${command} source acquisition failed.`)); else resolve(Buffer.concat(stdout).toString('utf8')) })
  })
}

function decodeSourceBytes(data: Buffer): { original: string; supported: boolean; byteHash: string } {
  const byteHash = createHash('sha256').update(data).digest('hex')
  try {
    if (data.includes(0)) throw new Error('Binary source')
    return { original: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data), supported: true, byteHash }
  } catch { return { original: data.toString('base64'), supported: false, byteHash } }
}
