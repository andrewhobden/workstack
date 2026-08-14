import { randomUUID } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { ProjectStore } from './project-store'
import type {
  CreateWikiAutomationArtifactInput,
  CreateWikiAutomationHandoffInput,
  CreateMergedPullRequestJobInput,
  LocalDependencyGraph,
  LocalDependencyGraphDelta,
  LocalDependencyGraphEdge,
  LocalDependencyGraphInput,
  WikiAutomationArtifact,
  WikiAutomationHandoff,
  WikiAutomationJob,
  WikiAutomationJobReport,
  WikiAutomationMergeEvidence,
  WikiGenerationJobInput
} from './types'

const jobInputSchema = z.object({
  title: z.string().trim().min(1),
  promptMarkdown: z.string().trim().min(1),
  sourcePaths: z.array(z.string().trim().min(1)).default([]),
  requestedBy: z.string().trim().min(1).optional()
})

const mergedPullRequestJobInputSchema = jobInputSchema.extend({
  mergeEvidence: z.object({
    pullRequestUrl: z.string().url(),
    pullRequestNumber: z.number().int().positive(),
    pullRequestTitle: z.string().trim().min(1),
    headRefName: z.string().trim().min(1),
    mergedAt: z.string().datetime().nullable().optional(),
    mergeCommitSha: z.string().trim().min(1),
    workItemId: z.string().trim().min(1),
    sessionSummaryMarkdown: z.string().default(''),
    diffMarkdown: z.string().default('')
  })
})

const artifactInputSchema = z.object({
  kind: z.enum(['dependency_graph', 'wiki_draft', 'wiki_article']),
  title: z.string().trim().min(1),
  contentMarkdown: z.string(),
  relativePath: z.string().trim().min(1).optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
})

const handoffInputSchema = z.object({
  target: z.string().trim().min(1),
  summaryMarkdown: z.string().trim().min(1),
  payload: z.record(z.string(), z.unknown()).default({})
})

const graphInputSchema = z.object({
  entryPaths: z.array(z.string().trim().min(1)).optional(),
  maxFiles: z.number().int().min(1).max(2_000).default(250),
  maxEdges: z.number().int().min(1).max(10_000).default(1_000),
  maxFileBytes: z.number().int().min(1).max(2_000_000).default(250_000)
})

const sourceExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'] as const
const ignoredDirectories = new Set(['.git', '.workstack', 'node_modules', 'dist', 'build', 'coverage'])
const importPattern = /(?:\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?|\brequire\s*\(|\bimport\s*\()\s*['"]([^'"]+)['"]/g
const maxGraphDeltaChanges = 1_000

interface JobRow {
  id: string
  title: string
  prompt_markdown: string
  source_paths_json: string
  requested_by: string | null
  status: WikiAutomationJob['status']
  error_message: string | null
  merge_key: string | null
  attempt_count: number
  created_at: string
  updated_at: string
  started_at: string | null
  completed_at: string | null
}

interface MergeEvidenceRow {
  job_id: string
  pull_request_url: string
  pull_request_number: number
  pull_request_title: string
  head_ref_name: string
  merged_at: string | null
  merge_commit_sha: string
  work_item_id: string
  session_summary_markdown: string
  diff_markdown: string
  created_at: string
}

interface ArtifactRow {
  id: string
  job_id: string
  kind: WikiAutomationArtifact['kind']
  title: string
  content_markdown: string
  relative_path: string | null
  metadata_json: string
  created_at: string
}

interface HandoffRow {
  id: string
  job_id: string
  target: string
  summary_markdown: string
  payload_json: string
  status: WikiAutomationHandoff['status']
  created_at: string
  resolved_at: string | null
}

export class WikiAutomationRepository {
  constructor(
    private readonly store: ProjectStore,
    private readonly dependencies: { clock?: Clock; id?: () => string } = {}
  ) {}

  createJob(input: WikiGenerationJobInput): WikiAutomationJob {
    const parsed = jobInputSchema.parse(input)
    const now = this.now()
    const job: WikiAutomationJob = {
      id: this.createId(),
      title: parsed.title,
      promptMarkdown: parsed.promptMarkdown,
      sourcePaths: parsed.sourcePaths,
      requestedBy: parsed.requestedBy ?? null,
      status: 'pending',
      errorMessage: null,
      mergeKey: null,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null
    }
    this.store.database.prepare(
      `INSERT INTO wiki_automation_jobs (
        id, title, prompt_markdown, source_paths_json, requested_by, status, error_message, merge_key, attempt_count,
        created_at, updated_at, started_at, completed_at
      ) VALUES (
        @id, @title, @promptMarkdown, @sourcePathsJson, @requestedBy, @status, @errorMessage,
        @mergeKey, @attemptCount,
        @createdAt, @updatedAt, @startedAt, @completedAt
      )`
    ).run({ ...job, sourcePathsJson: JSON.stringify(job.sourcePaths) })
    return job
  }

  createMergedPullRequestJob(input: CreateMergedPullRequestJobInput): WikiAutomationJob {
    const parsed = mergedPullRequestJobInputSchema.parse(input)
    const mergeKey = mergeIdentity(parsed.mergeEvidence.pullRequestUrl, parsed.mergeEvidence.mergeCommitSha)

    return this.immediate(() => {
      const now = this.now()
      const job = {
        id: this.createId(),
        title: parsed.title,
        promptMarkdown: parsed.promptMarkdown,
        sourcePaths: parsed.sourcePaths,
        requestedBy: parsed.requestedBy ?? null,
        status: 'pending' as const,
        errorMessage: null,
        mergeKey,
        attemptCount: 0,
        createdAt: now,
        updatedAt: now,
        startedAt: null,
        completedAt: null
      }
      const inserted = this.store.database.prepare(
        `INSERT INTO wiki_automation_jobs (
          id, title, prompt_markdown, source_paths_json, requested_by, status, error_message, merge_key, attempt_count,
          created_at, updated_at, started_at, completed_at
        ) VALUES (
          @id, @title, @promptMarkdown, @sourcePathsJson, @requestedBy, @status, @errorMessage, @mergeKey, @attemptCount,
          @createdAt, @updatedAt, @startedAt, @completedAt
        ) ON CONFLICT DO NOTHING`
      ).run({ ...job, sourcePathsJson: JSON.stringify(job.sourcePaths) })

      if (inserted.changes === 0) {
        const existing = this.store.database
          .prepare('SELECT * FROM wiki_automation_jobs WHERE merge_key = ?')
          .get(mergeKey) as JobRow | undefined
        if (!existing) throw new WorkstackError('INTERNAL_ERROR', 'Merged pull request job could not be read after conflict.')
        return toJob(existing)
      }

      this.store.database.prepare(
        `INSERT INTO wiki_automation_merge_evidence (
          job_id, pull_request_url, pull_request_number, pull_request_title, head_ref_name, merged_at,
          merge_commit_sha, work_item_id, session_summary_markdown, diff_markdown, created_at
        ) VALUES (
          @jobId, @pullRequestUrl, @pullRequestNumber, @pullRequestTitle, @headRefName, @mergedAt,
          @mergeCommitSha, @workItemId, @sessionSummaryMarkdown, @diffMarkdown, @createdAt
        )`
      ).run({ jobId: job.id, ...parsed.mergeEvidence, mergedAt: parsed.mergeEvidence.mergedAt ?? null, createdAt: now })
      return job
    })
  }

  getJob(jobId: string): WikiAutomationJob {
    const row = this.store.database.prepare('SELECT * FROM wiki_automation_jobs WHERE id = ?').get(jobId) as JobRow | undefined
    if (!row) throw new WorkstackError('VALIDATION_ERROR', 'Wiki automation job was not found.')
    return toJob(row)
  }

  listJobs(): WikiAutomationJob[] {
    return (this.store.database.prepare('SELECT * FROM wiki_automation_jobs ORDER BY created_at ASC, id ASC').all() as JobRow[]).map(toJob)
  }

  getMergeEvidence(jobId: string): WikiAutomationMergeEvidence {
    const row = this.store.database
      .prepare('SELECT * FROM wiki_automation_merge_evidence WHERE job_id = ?')
      .get(jobId) as MergeEvidenceRow | undefined
    if (!row) throw new WorkstackError('VALIDATION_ERROR', 'Merged pull request evidence was not found.')
    return toMergeEvidence(row)
  }

  private findMergeEvidence(jobId: string): WikiAutomationMergeEvidence | undefined {
    const row = this.store.database
      .prepare('SELECT * FROM wiki_automation_merge_evidence WHERE job_id = ?')
      .get(jobId) as MergeEvidenceRow | undefined
    return row ? toMergeEvidence(row) : undefined
  }

  getJobReport(jobId: string): WikiAutomationJobReport {
    return {
      job: this.getJob(jobId),
      mergeEvidence: this.findMergeEvidence(jobId),
      artifacts: this.listArtifacts(jobId),
      handoffs: this.listHandoffs(jobId)
    }
  }

  startNextJob(): WikiAutomationJob | undefined {
    return this.immediate(() => {
      const row = this.store.database
        .prepare("SELECT * FROM wiki_automation_jobs WHERE status = 'pending' ORDER BY created_at ASC, id ASC LIMIT 1")
        .get() as JobRow | undefined
      if (!row) return undefined
      const now = this.now()
      const result = this.store.database.prepare(
        `UPDATE wiki_automation_jobs
         SET status = 'running', started_at = ?, updated_at = ?, attempt_count = attempt_count + 1
         WHERE id = ? AND status = 'pending'`
      ).run(now, now, row.id)
      if (result.changes !== 1) return undefined
      return { ...toJob(row), status: 'running', startedAt: now, updatedAt: now, attemptCount: row.attempt_count + 1 }
    })
  }

  retryJob(jobId: string): WikiAutomationJob {
    return this.retryJobs("id = ? AND status IN ('failed', 'running')", [jobId])[0] ?? this.invalidRetry(jobId)
  }

  retryFailedJobs(): WikiAutomationJob[] {
    return this.retryJobs("status = 'failed'", [])
  }

  retryInterruptedJobs(): WikiAutomationJob[] {
    return this.retryJobs("status = 'running'", [])
  }

  completeJob(jobId: string): WikiAutomationJob {
    return this.transitionJob(jobId, 'completed')
  }

  failJob(jobId: string, errorMessage: string): WikiAutomationJob {
    const error = errorMessage.trim()
    if (!error) throw new WorkstackError('VALIDATION_ERROR', 'Wiki automation failure reason is required.')
    return this.transitionJob(jobId, 'failed', error)
  }

  addArtifact(jobId: string, input: CreateWikiAutomationArtifactInput): WikiAutomationArtifact {
    const parsed = artifactInputSchema.parse(input)
    this.getJob(jobId)
    const artifact: WikiAutomationArtifact = {
      id: this.createId(),
      jobId,
      kind: parsed.kind,
      title: parsed.title,
      contentMarkdown: parsed.contentMarkdown,
      relativePath: parsed.relativePath ?? null,
      metadata: parsed.metadata,
      createdAt: this.now()
    }
    this.store.database.prepare(
      `INSERT INTO wiki_automation_artifacts (
        id, job_id, kind, title, content_markdown, relative_path, metadata_json, created_at
      ) VALUES (@id, @jobId, @kind, @title, @contentMarkdown, @relativePath, @metadataJson, @createdAt)`
    ).run({ ...artifact, metadataJson: JSON.stringify(artifact.metadata) })
    return artifact
  }

  listArtifacts(jobId: string): WikiAutomationArtifact[] {
    this.getJob(jobId)
    return (this.store.database
      .prepare('SELECT * FROM wiki_automation_artifacts WHERE job_id = ? ORDER BY created_at ASC, id ASC')
      .all(jobId) as ArtifactRow[]).map(toArtifact)
  }

  findMostRelevantDependencyGraphArtifact(jobId: string): WikiAutomationArtifact | undefined {
    const job = this.getJob(jobId)
    const artifacts = (this.store.database.prepare(
      `SELECT a.*
       FROM wiki_automation_artifacts a
       JOIN wiki_automation_jobs j ON j.id = a.job_id
       WHERE a.kind = 'dependency_graph' AND a.job_id != ?
       ORDER BY a.created_at DESC, a.id DESC`
    ).all(jobId) as ArtifactRow[]).map(toArtifact)
    if (!artifacts.length) return undefined

    const sourcePaths = new Set(job.sourcePaths)
    return artifacts
      .map((artifact) => ({
        artifact,
        overlap: this.getJob(artifact.jobId).sourcePaths.filter((sourcePath) => sourcePaths.has(sourcePath)).length
      }))
      .sort((left, right) =>
        right.overlap - left.overlap ||
        right.artifact.createdAt.localeCompare(left.artifact.createdAt) ||
        right.artifact.id.localeCompare(left.artifact.id)
      )[0].artifact
  }

  getDependencyGraphSnapshot(artifact: WikiAutomationArtifact): LocalDependencyGraph | undefined {
    if (artifact.kind !== 'dependency_graph') return undefined
    return parseDependencyGraph(artifact.metadata.graph) ?? parseDependencyGraphContent(artifact.contentMarkdown)
  }

  buildLocalDependencyGraphDelta(
    graph: LocalDependencyGraph,
    previousGraph: LocalDependencyGraph | undefined,
    maxChanges = maxGraphDeltaChanges
  ): LocalDependencyGraphDelta {
    const limit = z.number().int().min(1).max(maxGraphDeltaChanges).parse(maxChanges)
    const previousNodes = new Set((previousGraph?.nodes ?? []).map((node) => node.path))
    const currentNodes = new Set(graph.nodes.map((node) => node.path))
    const previousEdges = new Set((previousGraph?.edges ?? []).map(edgeKey))
    const currentEdges = new Set(graph.edges.map(edgeKey))
    const addedNodes = [...currentNodes].filter((node) => !previousNodes.has(node)).sort().map((path) => ({ path }))
    const removedNodes = [...previousNodes].filter((node) => !currentNodes.has(node)).sort().map((path) => ({ path }))
    const addedEdges = graph.edges.filter((edge) => !previousEdges.has(edgeKey(edge))).sort(compareEdges)
    const removedEdges = (previousGraph?.edges ?? []).filter((edge) => !currentEdges.has(edgeKey(edge))).sort(compareEdges)
    const changes = [...addedNodes, ...removedNodes, ...addedEdges, ...removedEdges]
    return {
      addedNodes: addedNodes.slice(0, limit),
      removedNodes: removedNodes.slice(0, limit),
      addedEdges: addedEdges.slice(0, limit),
      removedEdges: removedEdges.slice(0, limit),
      truncated: graph.truncated || previousGraph?.truncated === true || changes.length > limit
    }
  }

  createHandoff(jobId: string, input: CreateWikiAutomationHandoffInput): WikiAutomationHandoff {
    const parsed = handoffInputSchema.parse(input)
    this.getJob(jobId)
    const handoff: WikiAutomationHandoff = {
      id: this.createId(),
      jobId,
      target: parsed.target,
      summaryMarkdown: parsed.summaryMarkdown,
      payload: parsed.payload,
      status: 'pending',
      createdAt: this.now(),
      resolvedAt: null
    }
    this.store.database.prepare(
      `INSERT INTO wiki_automation_handoffs (
        id, job_id, target, summary_markdown, payload_json, status, created_at, resolved_at
      ) VALUES (@id, @jobId, @target, @summaryMarkdown, @payloadJson, @status, @createdAt, @resolvedAt)`
    ).run({ ...handoff, payloadJson: JSON.stringify(handoff.payload) })
    return handoff
  }

  listHandoffs(jobId: string): WikiAutomationHandoff[] {
    this.getJob(jobId)
    return (this.store.database
      .prepare('SELECT * FROM wiki_automation_handoffs WHERE job_id = ? ORDER BY created_at ASC, id ASC')
      .all(jobId) as HandoffRow[]).map(toHandoff)
  }

  resolveHandoff(handoffId: string, accepted: boolean): WikiAutomationHandoff {
    const row = this.store.database.prepare('SELECT * FROM wiki_automation_handoffs WHERE id = ?').get(handoffId) as HandoffRow | undefined
    if (!row) throw new WorkstackError('VALIDATION_ERROR', 'Wiki automation handoff was not found.')
    if (row.status !== 'pending') throw new WorkstackError('INVALID_STATE_TRANSITION', 'Wiki automation handoff is already resolved.')
    const now = this.now()
    const status = accepted ? 'accepted' : 'rejected'
    this.store.database.prepare(
      "UPDATE wiki_automation_handoffs SET status = ?, resolved_at = ? WHERE id = ? AND status = 'pending'"
    ).run(status, now, handoffId)
    return { ...toHandoff(row), status, resolvedAt: now }
  }

  buildLocalDependencyGraph(input: LocalDependencyGraphInput = {}): LocalDependencyGraph {
    const parsed = graphInputSchema.parse(input)
    const root = this.store.paths.rootPath
    const discovered = parsed.entryPaths
      ? parsed.entryPaths.map((entry) => this.resolveProjectPath(root, entry)).filter((entry): entry is string => entry !== undefined)
      : listSourceFiles(root, parsed.maxFiles + 1)
    const entries = discovered.slice(0, parsed.maxFiles)
    const nodes = new Set<string>()
    const scanned = new Set<string>()
    const edges: Array<{ from: string; to: string }> = []
    const queued = new Set(entries)
    const queue = [...entries]
    let truncated = !parsed.entryPaths && discovered.length > parsed.maxFiles

    while (queue.length > 0) {
      const file = queue.shift()!
      const filePath = relative(root, file)
      if (scanned.has(filePath)) continue
      if (nodes.size >= parsed.maxFiles) {
        truncated = true
        break
      }
      nodes.add(filePath)
      scanned.add(filePath)
      const imports = localImports(file, root, parsed.maxFileBytes)
      for (const target of imports) {
        if (edges.length >= parsed.maxEdges) {
          truncated = true
          break
        }
        if (!nodes.has(relative(root, target)) && nodes.size >= parsed.maxFiles) {
          truncated = true
          continue
        }
        nodes.add(relative(root, target))
        edges.push({ from: relative(root, file), to: relative(root, target) })
        if (!queued.has(target)) {
          queued.add(target)
          queue.push(target)
        }
      }
      if (edges.length >= parsed.maxEdges) break
    }
    return {
      nodes: [...nodes].sort().map((file) => ({ path: file })),
      edges: edges.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to)),
      truncated
    }
  }

  private transitionJob(jobId: string, status: 'completed' | 'failed', errorMessage: string | null = null): WikiAutomationJob {
    const job = this.getJob(jobId)
    if (job.status !== 'running') {
      throw new WorkstackError('INVALID_STATE_TRANSITION', 'Wiki automation job must be running before it can be finalized.')
    }
    const now = this.now()
    this.store.database.prepare(
      `UPDATE wiki_automation_jobs
       SET status = ?, error_message = ?, updated_at = ?, completed_at = ?
       WHERE id = ? AND status = 'running'`
    ).run(status, errorMessage, now, now, jobId)
    return { ...job, status, errorMessage, updatedAt: now, completedAt: now }
  }

  private retryJobs(condition: string, parameters: unknown[]): WikiAutomationJob[] {
    return this.immediate(() => {
      const rows = this.store.database
        .prepare(`SELECT * FROM wiki_automation_jobs WHERE ${condition} ORDER BY created_at ASC, id ASC`)
        .all(...parameters) as JobRow[]
      if (!rows.length) return []
      const now = this.now()
      const result = this.store.database.prepare(
        `UPDATE wiki_automation_jobs
         SET status = 'pending', error_message = NULL, updated_at = ?, started_at = NULL, completed_at = NULL
         WHERE ${condition}`
      ).run(now, ...parameters)
      if (result.changes !== rows.length) throw new WorkstackError('INTERNAL_ERROR', 'Wiki automation retry was interrupted.')
      return rows.map((row) => ({
        ...toJob(row),
        status: 'pending' as const,
        errorMessage: null,
        updatedAt: now,
        startedAt: null,
        completedAt: null
      }))
    })
  }

  private invalidRetry(jobId: string): never {
    const job = this.getJob(jobId)
    throw new WorkstackError('INVALID_STATE_TRANSITION', `Wiki automation job in ${job.status} state cannot be retried.`)
  }

  private resolveProjectPath(root: string, entry: string): string | undefined {
    const candidate = path.resolve(root, entry)
    if (!isInside(root, candidate)) throw new WorkstackError('VALIDATION_ERROR', 'Dependency graph paths must stay inside the project root.')
    try {
      return statSync(candidate).isFile() && isSourceFile(candidate) ? candidate : undefined
    } catch {
      return undefined
    }
  }

  private immediate<T>(operation: () => T): T {
    return this.store.database.transaction(operation).immediate()
  }

  private now(): string {
    return (this.dependencies.clock ?? systemClock).now().toISOString()
  }

  private createId(): string {
    return (this.dependencies.id ?? randomUUID)()
  }
}

function listSourceFiles(root: string, maxFiles: number): string[] {
  const files: string[] = []
  const visit = (directory: string): void => {
    if (files.length >= maxFiles) return
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= maxFiles) return
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) visit(target)
      } else if (entry.isFile() && isSourceFile(target)) {
        files.push(target)
      }
    }
  }
  visit(root)
  return files
}

function localImports(file: string, root: string, maxFileBytes: number): string[] {
  let content: string
  try {
    if (statSync(file).size > maxFileBytes) return []
    content = readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const imports = new Set<string>()
  for (const match of content.matchAll(importPattern)) {
    const specifier = match[1]
    if (!specifier.startsWith('.')) continue
    const target = resolveImport(file, specifier, root)
    if (target) imports.add(target)
  }
  return [...imports]
}

function resolveImport(file: string, specifier: string, root: string): string | undefined {
  const base = path.resolve(path.dirname(file), specifier)
  if (!isInside(root, base)) return undefined
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`))
  ]
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile() && isSourceFile(candidate)
    } catch {
      return false
    }
  })
}

function isSourceFile(file: string): boolean {
  return sourceExtensions.includes(path.extname(file) as (typeof sourceExtensions)[number])
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate)
  return relativePath !== '' && !relativePath.startsWith(`..${path.sep}`) && relativePath !== '..' && !path.isAbsolute(relativePath)
}

function relative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

function edgeKey(edge: LocalDependencyGraphEdge): string {
  return `${edge.from}\u0000${edge.to}`
}

function compareEdges(left: LocalDependencyGraphEdge, right: LocalDependencyGraphEdge): number {
  return left.from.localeCompare(right.from) || left.to.localeCompare(right.to)
}

function parseDependencyGraph(value: unknown): LocalDependencyGraph | undefined {
  const parsed = z.object({
    nodes: z.array(z.object({ path: z.string() })),
    edges: z.array(z.object({ from: z.string(), to: z.string() })),
    truncated: z.boolean()
  }).safeParse(value)
  return parsed.success ? parsed.data : undefined
}

function parseDependencyGraphContent(content: string): LocalDependencyGraph | undefined {
  const json = content.match(/```json\s*\n([\s\S]*?)\n```/)?.[1] ?? content
  try {
    return parseDependencyGraph(JSON.parse(json))
  } catch {
    return undefined
  }
}

function toJob(row: JobRow): WikiAutomationJob {
  return {
    id: row.id,
    title: row.title,
    promptMarkdown: row.prompt_markdown,
    sourcePaths: JSON.parse(row.source_paths_json) as string[],
    requestedBy: row.requested_by,
    status: row.status,
    errorMessage: row.error_message,
    mergeKey: row.merge_key,
    attemptCount: row.attempt_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    completedAt: row.completed_at
  }
}

function toMergeEvidence(row: MergeEvidenceRow): WikiAutomationMergeEvidence {
  return {
    jobId: row.job_id,
    pullRequestUrl: row.pull_request_url,
    pullRequestNumber: row.pull_request_number,
    pullRequestTitle: row.pull_request_title,
    headRefName: row.head_ref_name,
    mergedAt: row.merged_at,
    mergeCommitSha: row.merge_commit_sha,
    workItemId: row.work_item_id,
    sessionSummaryMarkdown: row.session_summary_markdown,
    diffMarkdown: row.diff_markdown,
    createdAt: row.created_at
  }
}

function mergeIdentity(pullRequestUrl: string, mergeCommitSha: string): string {
  return `${pullRequestUrl.trim()}:${mergeCommitSha.trim()}`
}

function toArtifact(row: ArtifactRow): WikiAutomationArtifact {
  return {
    id: row.id,
    jobId: row.job_id,
    kind: row.kind,
    title: row.title,
    contentMarkdown: row.content_markdown,
    relativePath: row.relative_path,
    metadata: JSON.parse(row.metadata_json) as Record<string, unknown>,
    createdAt: row.created_at
  }
}

function toHandoff(row: HandoffRow): WikiAutomationHandoff {
  return {
    id: row.id,
    jobId: row.job_id,
    target: row.target,
    summaryMarkdown: row.summary_markdown,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}
