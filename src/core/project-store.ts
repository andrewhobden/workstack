import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { migrate } from './migrations'
import { acquireProjectOperation, assertProjectAvailable, atomicWriteText, projectLifecyclePath, withProcessLock, type ProjectOperationLease } from './project-lifecycle'
import { DEFAULT_COPILOT_LAUNCH_PROMPT, LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT } from './types'
import { relocateTaskWorkspaces } from './workspace-relocation'
import type {
  InitializeProjectInput,
  ProjectMetadata,
  ProjectSettings,
  UpdateProjectInput,
  WorkstackPaths
} from './types'

const projectSettingsSchema = z.object({
  workItemPrefix: z.string().regex(/^[A-Z][A-Z0-9]*$/),
  defaultLeaseSeconds: z.number().int().min(60),
  heartbeatSeconds: z.number().int().min(30),
  autoReleaseExpiredClaims: z.boolean(),
  autoUpdateKnowledgeOnCompletion: z.boolean(),
  agentExecutionProfile: z.enum(['inspection', 'implementation', 'advanced']).default('inspection'),
  knowledgeChatProfile: z.enum(['inspection', 'advanced']).default('inspection'),
  copilotLaunchPrompt: z.string().trim().min(1).max(20_000)
}).refine((settings) => settings.heartbeatSeconds < settings.defaultLeaseSeconds, {
  message: 'Heartbeat interval must be shorter than the default lease.', path: ['heartbeatSeconds']
})

const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().default(''),
  rootPath: z.string().min(1),
  workItemPrefix: z.string().regex(/^[A-Z][A-Z0-9]*$/),
  defaultLeaseSeconds: z.number().int().min(60).default(1800),
  heartbeatSeconds: z.number().int().min(30).default(300),
  autoReleaseExpiredClaims: z.boolean().default(true),
  autoUpdateKnowledgeOnCompletion: z.boolean().default(true),
  agentExecutionProfile: z.enum(['inspection', 'implementation', 'advanced']).default('inspection'),
  knowledgeChatProfile: z.enum(['inspection', 'advanced']).default('inspection'),
  copilotLaunchPrompt: z.string().trim().min(1).max(20_000).default(DEFAULT_COPILOT_LAUNCH_PROMPT),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export class ProjectStore {
  readonly database: Database.Database

  private constructor(
    readonly paths: WorkstackPaths,
    private metadata: ProjectMetadata,
    database: Database.Database,
    private readonly operationLease?: ProjectOperationLease,
    private readonly metadataWriter: typeof atomicWriteText = atomicWriteText
  ) {
    this.database = database
  }

  static async initialize(
    input: InitializeProjectInput,
    dependencies: { clock?: Clock; id?: () => string; writeMetadata?: typeof atomicWriteText } = {}
  ): Promise<ProjectStore> {
    const paths = projectPaths(input.rootPath)
    const clock = dependencies.clock ?? systemClock
    const createId = dependencies.id ?? randomUUID
    const name = input.name.trim()

    if (!name) {
      throw new WorkstackError('VALIDATION_ERROR', 'Project name is required.')
    }

    const settings = projectSettingsSchema.safeParse(defaultSettings(input.workItemPrefix ?? derivePrefix(name)))
    if (!settings.success) {
      throw new WorkstackError('VALIDATION_ERROR', `Invalid project settings: ${settings.error.message}`)
    }

    await mkdir(paths.rootPath, { recursive: true })
    const now = clock.now().toISOString()
    const initial: ProjectMetadata = {
      id: createId(),
      name,
      description: input.description?.trim() ?? '',
      rootPath: path.resolve(input.rootPath),
      settings: settings.data,
      createdAt: now,
      updatedAt: now
    }

    const lease = acquireProjectOperation(paths.rootPath, true)
    try {
      return await withProcessLock(projectLifecyclePath(paths.rootPath), 'metadata', async () => {
        const document = await readOptionalMetadata(paths.projectPath)
        const hadDatabase = await exists(paths.databasePath)
        await createProjectLayout(paths)
        const database = openDatabase(paths.databasePath)
        try {
          let metadata = readDatabaseMetadata(database)
          if (!metadata) {
            if (hadDatabase && !document) throw new WorkstackError('PROJECT_NOT_FOUND', 'Project identity is missing from its database and metadata. Restore a backup.')
            metadata = document ?? initial
            database.prepare(`INSERT INTO projects (id, name, description, root_path, settings_json, created_at, updated_at)
              VALUES (@id, @name, @description, @rootPath, @settingsJson, @createdAt, @updatedAt)`).run(projectRecordValues(metadata))
          }
          assertDocumentIdentity(document, metadata)
          if (path.resolve(metadata.rootPath) !== paths.rootPath) {
            await requireOriginalProjectMoved(metadata)
            relocateTaskWorkspaces(metadata.rootPath, paths.rootPath)
            metadata = { ...metadata, rootPath: paths.rootPath, updatedAt: nextUpdatedAt(metadata, clock) }
            database.prepare('UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?').run(metadata.rootPath, metadata.updatedAt, metadata.id)
          }
          const store = new ProjectStore(paths, metadata, database, lease, dependencies.writeMetadata)
          store.exportMetadata(metadata)
          return store
        } catch (error) { database.close(); throw error }
      })
    } catch (error) { lease.release(); throw error }
  }

  static async open(rootPath: string): Promise<ProjectStore> {
    const paths = projectPaths(rootPath)
    if (!(await exists(paths.databasePath))) {
      assertProjectAvailable(rootPath)
      throw new WorkstackError('PROJECT_NOT_FOUND', `No Workstack project exists at ${path.resolve(rootPath)}.`)
    }

    const lease = acquireProjectOperation(paths.rootPath)
    try {
      return await withProcessLock(projectLifecyclePath(paths.rootPath), 'metadata', async () => {
        const document = await readOptionalMetadata(paths.projectPath)
        const database = openDatabase(paths.databasePath)
        try {
          const metadata = requireDatabaseMetadata(database)
          assertDocumentIdentity(document, metadata)
          const store = new ProjectStore(paths, metadata, database, lease)
          if (!document || serializeProjectMetadata(document) !== serializeProjectMetadata(metadata)) store.exportMetadata(metadata)
          return store
        } catch (error) { database.close(); throw error }
      })
    } catch (error) { lease.release(); throw error }
  }

  /** Enumeration reads the existing schema without migrating, exporting or registering it. */
  static async openReadOnly(rootPath: string): Promise<ProjectStore> {
    const paths = projectPaths(rootPath)
    assertProjectAvailable(rootPath)
    if (!(await exists(paths.databasePath))) throw new WorkstackError('PROJECT_NOT_FOUND', `No Workstack project exists at ${paths.rootPath}.`)
    const document = await readOptionalMetadata(paths.projectPath)
    const database = new Database(paths.databasePath, { readonly: true, fileMustExist: true })
    try {
      const metadata = requireDatabaseMetadata(database)
      assertDocumentIdentity(document, metadata)
      return new ProjectStore(paths, metadata, database)
    } catch (error) { database.close(); throw error }
  }

  static readMetadataDocument(rootPath: string): Promise<ProjectMetadata> {
    return readProjectMetadata(projectPaths(rootPath).projectPath)
  }

  get project(): ProjectMetadata {
    return structuredClone(requireDatabaseMetadata(this.database, this.metadata.id))
  }

  async updateMetadata(
    updates: UpdateProjectInput,
    clock: Clock = systemClock
  ): Promise<ProjectMetadata> {
    return withProcessLock(projectLifecyclePath(this.paths.rootPath), 'metadata', () => {
      const current = this.project
      const name = updates.name === undefined ? current.name : updates.name.trim()
      if (!name) {
        throw new WorkstackError('VALIDATION_ERROR', 'Project name is required.')
      }

      const settings = projectSettingsSchema.safeParse({
        ...current.settings,
        ...updates.settings
    })
    if (!settings.success) {
      throw new WorkstackError('VALIDATION_ERROR', `Invalid project settings: ${settings.error.message}`)
    }

    const next: ProjectMetadata = {
      ...current,
      name,
      description: updates.description === undefined ? current.description : updates.description.trim(),
      settings: settings.data,
      updatedAt: nextUpdatedAt(current, clock)
    }

    this.database
      .prepare(
        `UPDATE projects
         SET name = @name, description = @description, settings_json = @settingsJson, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ ...next, settingsJson: JSON.stringify(next.settings) })
    this.metadata = next
    this.exportMetadata(next)
    return this.project
    })
  }

  async reconnectRoot(): Promise<ProjectMetadata> {
    return withProcessLock(projectLifecyclePath(this.paths.rootPath), 'metadata', async () => {
      const current = this.project
      if (path.resolve(current.rootPath) === this.paths.rootPath) return current
      await requireOriginalProjectMoved(current)
      relocateTaskWorkspaces(current.rootPath, this.paths.rootPath)
      const next = { ...current, rootPath: this.paths.rootPath, updatedAt: nextUpdatedAt(current, systemClock) }
      this.database.prepare('UPDATE projects SET root_path = ?, updated_at = ? WHERE id = ?').run(next.rootPath, next.updatedAt, next.id)
      this.metadata = next
      this.exportMetadata(next)
      return this.project
    })
  }

  runInOperation<T>(operation: () => T): T {
    return this.operationLease ? this.operationLease.run(operation) : operation()
  }

  private exportMetadata(metadata: ProjectMetadata): void {
    try { this.metadataWriter(this.paths.projectPath, serializeProjectMetadata(metadata)) } catch (error) {
      throw new WorkstackError('INTERNAL_ERROR', `Project metadata is committed in SQLite, but project.json could not be exported. Reopen the project to repair it. ${String(error)}`)
    }
  }

  close(): void {
    try { if (this.database.open) this.database.close() } finally { this.operationLease?.release() }
  }

  checksum(value: string): string {
    return createHash('sha256').update(value).digest('hex')
  }
}

export function projectPaths(rootPath: string): WorkstackPaths {
  const absoluteRootPath = path.resolve(rootPath)
  const workstackPath = path.join(absoluteRootPath, '.workstack')
  const knowledgePath = path.join(workstackPath, 'knowledge')

  return {
    rootPath: absoluteRootPath,
    workstackPath,
    databasePath: path.join(workstackPath, 'workstack.db'),
    projectPath: path.join(workstackPath, 'project.json'),
    knowledgePath,
    wikiPath: path.join(knowledgePath, 'wiki'),
    rawKnowledgePath: path.join(knowledgePath, 'raw'),
    workItemsPath: path.join(workstackPath, 'work-items'),
    logsPath: path.join(workstackPath, 'logs')
  }
}

function projectRecordValues(metadata: ProjectMetadata): {
  id: string
  name: string
  description: string
  rootPath: string
  settingsJson: string
  createdAt: string
  updatedAt: string
} {
  return {
    id: metadata.id,
    name: metadata.name,
    description: metadata.description,
    rootPath: metadata.rootPath,
    settingsJson: JSON.stringify(metadata.settings),
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  }
}

function defaultSettings(workItemPrefix: string): ProjectSettings {
  return {
    workItemPrefix,
    defaultLeaseSeconds: 1800,
    heartbeatSeconds: 300,
    autoReleaseExpiredClaims: true,
    autoUpdateKnowledgeOnCompletion: true,
    agentExecutionProfile: 'inspection',
    knowledgeChatProfile: 'inspection',
    copilotLaunchPrompt: DEFAULT_COPILOT_LAUNCH_PROMPT
  }
}

function derivePrefix(name: string): string {
  const letters = name
    .toUpperCase()
    .match(/[A-Z0-9]+/g)
    ?.join('')
    .slice(0, 6)

  return letters || 'WS'
}

async function createProjectLayout(paths: WorkstackPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.wikiPath, { recursive: true }),
    mkdir(paths.rawKnowledgePath, { recursive: true }),
    mkdir(paths.workItemsPath, { recursive: true }),
    mkdir(paths.logsPath, { recursive: true })
  ])

  await Promise.all([
    writeFile(path.join(paths.knowledgePath, 'schema.md'), '# Workstack knowledge schema\n', { flag: 'wx' }).catch(ignoreExisting),
    writeFile(path.join(paths.knowledgePath, 'index.md'), '# Knowledge index\n', { flag: 'wx' }).catch(ignoreExisting),
    writeFile(path.join(paths.knowledgePath, 'log.md'), '# Knowledge log\n', { flag: 'wx' }).catch(ignoreExisting)
  ])
}

function openDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath)
  try {
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  migrate(database)
  return database
  } catch (error) { database.close(); throw error }
}

async function readProjectMetadata(projectPath: string): Promise<ProjectMetadata> {
  const parsed = projectSchema.safeParse(JSON.parse(await readFile(projectPath, 'utf8')))
  if (!parsed.success) {
    throw new WorkstackError('VALIDATION_ERROR', `Invalid project metadata: ${parsed.error.message}`)
  }

  return {
    id: parsed.data.id,
    name: parsed.data.name,
    description: parsed.data.description,
    rootPath: parsed.data.rootPath,
    settings: {
      workItemPrefix: parsed.data.workItemPrefix,
      defaultLeaseSeconds: parsed.data.defaultLeaseSeconds,
      heartbeatSeconds: parsed.data.heartbeatSeconds,
      autoReleaseExpiredClaims: parsed.data.autoReleaseExpiredClaims,
      autoUpdateKnowledgeOnCompletion: parsed.data.autoUpdateKnowledgeOnCompletion,
      agentExecutionProfile: parsed.data.agentExecutionProfile,
      knowledgeChatProfile: parsed.data.knowledgeChatProfile,
      copilotLaunchPrompt: parsed.data.copilotLaunchPrompt === LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT
        ? DEFAULT_COPILOT_LAUNCH_PROMPT
        : parsed.data.copilotLaunchPrompt
    },
    createdAt: parsed.data.createdAt,
    updatedAt: parsed.data.updatedAt
  }
}

function serializeProjectMetadata(metadata: ProjectMetadata): string {
  return `${JSON.stringify(
    {
      id: metadata.id,
      name: metadata.name,
      description: metadata.description,
      rootPath: metadata.rootPath,
      workItemPrefix: metadata.settings.workItemPrefix,
      defaultLeaseSeconds: metadata.settings.defaultLeaseSeconds,
      heartbeatSeconds: metadata.settings.heartbeatSeconds,
      autoReleaseExpiredClaims: metadata.settings.autoReleaseExpiredClaims,
      autoUpdateKnowledgeOnCompletion: metadata.settings.autoUpdateKnowledgeOnCompletion,
      agentExecutionProfile: metadata.settings.agentExecutionProfile,
      knowledgeChatProfile: metadata.settings.knowledgeChatProfile,
      copilotLaunchPrompt: metadata.settings.copilotLaunchPrompt,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt
    },
    null,
    2
  )}\n`
}

async function readOptionalMetadata(projectPath: string): Promise<ProjectMetadata | undefined> {
  return await exists(projectPath) ? readProjectMetadata(projectPath) : undefined
}

interface ProjectRow {
  id: string; name: string; description: string; root_path: string; settings_json: string; created_at: string; updated_at: string
}

function readDatabaseMetadata(database: Database.Database): ProjectMetadata | undefined {
  const rows = database.prepare('SELECT * FROM projects').all() as ProjectRow[]
  if (rows.length > 1) throw new WorkstackError('PROJECT_NOT_FOUND', 'The project database contains conflicting project identities.')
  const row = rows[0]
  if (!row) return undefined
  const settings = { ...defaultSettings('WS'), ...JSON.parse(row.settings_json) } as ProjectSettings
  if (settings.copilotLaunchPrompt === LEGACY_DEFAULT_COPILOT_LAUNCH_PROMPT) settings.copilotLaunchPrompt = DEFAULT_COPILOT_LAUNCH_PROMPT
  const checked = projectSchema.safeParse({ id: row.id, name: row.name, description: row.description, rootPath: row.root_path, ...settings, createdAt: row.created_at, updatedAt: row.updated_at })
  if (!checked.success) throw new WorkstackError('VALIDATION_ERROR', `Invalid project database metadata: ${checked.error.message}`)
  return { id: row.id, name: row.name, description: row.description, rootPath: row.root_path, settings, createdAt: row.created_at, updatedAt: row.updated_at }
}

function requireDatabaseMetadata(database: Database.Database, id?: string): ProjectMetadata {
  const metadata = readDatabaseMetadata(database)
  if (!metadata || (id && metadata.id !== id)) throw new WorkstackError('PROJECT_NOT_FOUND', 'Project metadata and database state are inconsistent.')
  return metadata
}

function assertDocumentIdentity(document: ProjectMetadata | undefined, metadata: ProjectMetadata): void {
  if (document && document.id !== metadata.id) throw new WorkstackError('PROJECT_NOT_FOUND', 'Project metadata and database identities are inconsistent.')
}

function nextUpdatedAt(metadata: ProjectMetadata, clock: Clock): string {
  return new Date(Math.max(clock.now().getTime(), Date.parse(metadata.updatedAt) + 1)).toISOString()
}

async function requireOriginalProjectMoved(metadata: ProjectMetadata): Promise<void> {
  const originalDatabasePath = projectPaths(metadata.rootPath).databasePath
  if (!(await exists(originalDatabasePath))) return
  const original = new Database(originalDatabasePath, { readonly: true, fileMustExist: true })
  try {
    if (readDatabaseMetadata(original)?.id === metadata.id) {
      throw new WorkstackError('VALIDATION_ERROR', 'This project still exists at its original folder. Move it instead of copying it, or create a new project identity for the copy.')
    }
  } finally { original.close() }
}

function ignoreExisting(error: unknown): void {
  if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    throw error
  }
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}
