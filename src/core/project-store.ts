import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import Database from 'better-sqlite3'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { migrate } from './migrations'
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
  autoUpdateKnowledgeOnCompletion: z.boolean()
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
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
})

export class ProjectStore {
  readonly database: Database.Database

  private constructor(
    readonly paths: WorkstackPaths,
    private metadata: ProjectMetadata,
    database: Database.Database
  ) {
    this.database = database
  }

  static async initialize(
    input: InitializeProjectInput,
    dependencies: { clock?: Clock; id?: () => string } = {}
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
    const projectFileExists = await exists(paths.projectPath)

    if (projectFileExists) {
      return ProjectStore.open(input.rootPath)
    }

    const now = clock.now().toISOString()
    const metadata: ProjectMetadata = {
      id: createId(),
      name,
      description: input.description?.trim() ?? '',
      rootPath: path.resolve(input.rootPath),
      settings: settings.data,
      createdAt: now,
      updatedAt: now
    }

    await createProjectLayout(paths)
    await createProjectMetadata(paths.projectPath, metadata)

    const database = openDatabase(paths.databasePath)
    database
      .prepare(
        `INSERT INTO projects (id, name, description, root_path, settings_json, created_at, updated_at)
         VALUES (@id, @name, @description, @rootPath, @settingsJson, @createdAt, @updatedAt)`
      )
      .run({
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        rootPath: metadata.rootPath,
        settingsJson: JSON.stringify(metadata.settings),
        createdAt: metadata.createdAt,
        updatedAt: metadata.updatedAt
      })

    return new ProjectStore(paths, metadata, database)
  }

  static async open(rootPath: string): Promise<ProjectStore> {
    const paths = projectPaths(rootPath)
    if (!(await exists(paths.projectPath))) {
      throw new WorkstackError('PROJECT_NOT_FOUND', `No Workstack project exists at ${path.resolve(rootPath)}.`)
    }

    const metadata = await readProjectMetadata(paths.projectPath)
    const database = openDatabase(paths.databasePath)
    const persistedProject = database.prepare('SELECT id FROM projects WHERE id = ?').get(metadata.id)

    if (!persistedProject) {
      database.close()
      throw new WorkstackError('PROJECT_NOT_FOUND', 'Project metadata and database state are inconsistent.')
    }

    return new ProjectStore(paths, metadata, database)
  }

  get project(): ProjectMetadata {
    return structuredClone(this.metadata)
  }

  async updateMetadata(
    updates: UpdateProjectInput,
    clock: Clock = systemClock
  ): Promise<ProjectMetadata> {
    const name = updates.name === undefined ? this.metadata.name : updates.name.trim()
    if (!name) {
      throw new WorkstackError('VALIDATION_ERROR', 'Project name is required.')
    }

    const settings = projectSettingsSchema.safeParse({
      ...this.metadata.settings,
      ...updates.settings
    })
    if (!settings.success) {
      throw new WorkstackError('VALIDATION_ERROR', `Invalid project settings: ${settings.error.message}`)
    }

    const next: ProjectMetadata = {
      ...this.metadata,
      name,
      description: updates.description === undefined ? this.metadata.description : updates.description.trim(),
      settings: settings.data,
      updatedAt: clock.now().toISOString()
    }

    this.database
      .prepare(
        `UPDATE projects
         SET name = @name, description = @description, settings_json = @settingsJson, updated_at = @updatedAt
         WHERE id = @id`
      )
      .run({ ...next, settingsJson: JSON.stringify(next.settings) })
    await replaceProjectMetadata(this.paths.projectPath, next)
    this.metadata = next
    return this.project
  }

  close(): void {
    this.database.close()
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

function defaultSettings(workItemPrefix: string): ProjectSettings {
  return {
    workItemPrefix,
    defaultLeaseSeconds: 1800,
    heartbeatSeconds: 300,
    autoReleaseExpiredClaims: true,
    autoUpdateKnowledgeOnCompletion: true
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
    writeFile(path.join(paths.knowledgePath, 'schema.md'), '# Workstack knowledge schema\n', { flag: 'wx' }),
    writeFile(path.join(paths.knowledgePath, 'index.md'), '# Knowledge index\n', { flag: 'wx' }),
    writeFile(path.join(paths.knowledgePath, 'log.md'), '# Knowledge log\n', { flag: 'wx' })
  ])
}

function openDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath)
  database.pragma('foreign_keys = ON')
  database.pragma('journal_mode = WAL')
  database.pragma('busy_timeout = 5000')
  migrate(database)
  return database
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
      autoUpdateKnowledgeOnCompletion: parsed.data.autoUpdateKnowledgeOnCompletion
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
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt
    },
    null,
    2
  )}\n`
}

async function createProjectMetadata(projectPath: string, metadata: ProjectMetadata): Promise<void> {
  await writeFile(projectPath, serializeProjectMetadata(metadata), { encoding: 'utf8', flag: 'wx' })
}

async function replaceProjectMetadata(projectPath: string, metadata: ProjectMetadata): Promise<void> {
  const temporaryPath = `${projectPath}.tmp`
  await writeFile(temporaryPath, serializeProjectMetadata(metadata), 'utf8')
  await rename(temporaryPath, projectPath)
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
