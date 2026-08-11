import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import type { ProjectMetadata, ProjectRegistryRecord } from './types'

const projectRegistryRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  rootPath: z.string().min(1),
  lastOpenedAt: z.string().datetime()
})

const registrySchema = z.object({
  version: z.literal(1),
  projects: z.array(projectRegistryRecordSchema)
})

type RegistryDocument = z.infer<typeof registrySchema>

export class ProjectRegistry {
  constructor(
    private readonly filePath: string,
    private readonly clock: Clock = systemClock
  ) {}

  get deletionBackupDirectory(): string {
    return path.join(path.dirname(this.filePath), 'backups', 'project-deletions')
  }

  async list(): Promise<ProjectRegistryRecord[]> {
    const registry = await this.read()
    return [...registry.projects]
      .sort((left, right) => right.lastOpenedAt.localeCompare(left.lastOpenedAt))
      .map((project) => structuredClone(project))
  }

  async find(id: string): Promise<ProjectRegistryRecord | undefined> {
    const project = (await this.read()).projects.find((candidate) => candidate.id === id)
    return project ? structuredClone(project) : undefined
  }

  async register(project: ProjectMetadata): Promise<ProjectRegistryRecord> {
    const registry = await this.read()
    const record = toRegistryRecord(project, this.clock.now().toISOString())
    const existingByIdIndex = registry.projects.findIndex((candidate) => candidate.id === record.id)
    const conflictingRoot = registry.projects.find(
      (candidate) => candidate.rootPath === record.rootPath && candidate.id !== record.id
    )

    if (conflictingRoot) {
      throw new WorkstackError('VALIDATION_ERROR', 'This project folder is already registered.')
    }

    if (existingByIdIndex === -1) {
      registry.projects.push(record)
    } else {
      registry.projects[existingByIdIndex] = record
    }

    await this.write(registry)
    return structuredClone(record)
  }

  async update(
    id: string,
    updates: Pick<ProjectRegistryRecord, 'name' | 'description'>
  ): Promise<ProjectRegistryRecord> {
    const registry = await this.read()
    const project = registry.projects.find((candidate) => candidate.id === id)
    if (!project) {
      throw new WorkstackError('PROJECT_NOT_FOUND', 'The selected project is not registered.')
    }

    const name = updates.name.trim()
    if (!name) {
      throw new WorkstackError('VALIDATION_ERROR', 'Project name is required.')
    }

    project.name = name
    project.description = updates.description.trim()
    project.lastOpenedAt = this.clock.now().toISOString()
    await this.write(registry)
    return structuredClone(project)
  }

  async detach(id: string): Promise<boolean> {
    return this.remove(id)
  }

  async remove(id: string): Promise<boolean> {
    const registry = await this.read()
    const remainingProjects = registry.projects.filter((project) => project.id !== id)
    if (remainingProjects.length === registry.projects.length) {
      return false
    }

    registry.projects = remainingProjects
    await this.write(registry)
    return true
  }

  private async read(): Promise<RegistryDocument> {
    if (!(await fileExists(this.filePath))) {
      return { version: 1, projects: [] }
    }

    const parsed = registrySchema.safeParse(JSON.parse(await readFile(this.filePath, 'utf8')))
    if (!parsed.success) {
      throw new WorkstackError('VALIDATION_ERROR', `Invalid project registry: ${parsed.error.message}`)
    }

    return parsed.data
  }

  private async write(registry: RegistryDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.tmp`
    await writeFile(temporaryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
    await rename(temporaryPath, this.filePath)
  }
}

function toRegistryRecord(project: ProjectMetadata, lastOpenedAt: string): ProjectRegistryRecord {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    rootPath: project.rootPath,
    lastOpenedAt
  }
}

async function fileExists(filePath: string): Promise<boolean> {
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
