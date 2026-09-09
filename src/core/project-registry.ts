import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { systemClock, type Clock } from './clock'
import { WorkstackError } from './errors'
import { atomicWriteText, withProcessLock } from './project-lifecycle'
import type { ProjectMetadata, ProjectRegistryRecord } from './types'

const projectRegistryRecordSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string(),
  rootPath: z.string().min(1),
  lastOpenedAt: z.string().datetime(),
  metadataUpdatedAt: z.string().datetime().optional()
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
      .map(publicRecord)
  }

  async find(id: string): Promise<ProjectRegistryRecord | undefined> {
    const project = (await this.read()).projects.find((candidate) => candidate.id === id)
    return project ? publicRecord(project) : undefined
  }

  async register(project: ProjectMetadata): Promise<ProjectRegistryRecord> {
    return this.mutateRegistration(project, false)
  }

  /** Updating a projection must never resurrect a concurrently detached project. */
  async refresh(project: ProjectMetadata): Promise<ProjectRegistryRecord> {
    return this.mutateRegistration(project, true)
  }

  private async mutateRegistration(project: ProjectMetadata, requireExisting: boolean): Promise<ProjectRegistryRecord> {
    return withProcessLock(`${this.filePath}.lock.sqlite`, 'registry', async () => {
      const registry = await this.read()
      const record = { ...toRegistryRecord(project, this.clock.now().toISOString()), metadataUpdatedAt: project.updatedAt }
      const existingByIdIndex = registry.projects.findIndex((candidate) => candidate.id === record.id)
      if (requireExisting && existingByIdIndex === -1) {
        throw new WorkstackError('PROJECT_NOT_FOUND', 'The project was detached while its metadata was being updated. Reconnect it to restore the registration.')
      }
      const existing = registry.projects[existingByIdIndex]
      if (existing?.metadataUpdatedAt && existing.metadataUpdatedAt > project.updatedAt) return publicRecord(existing)
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
      return publicRecord(record)
    })
  }

  async update(
    id: string,
    updates: Pick<ProjectRegistryRecord, 'name' | 'description'>
  ): Promise<ProjectRegistryRecord> {
    return withProcessLock(`${this.filePath}.lock.sqlite`, 'registry', async () => {
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
      return publicRecord(project)
    })
  }

  async detach(id: string): Promise<boolean> {
    return this.remove(id)
  }

  async remove(id: string): Promise<boolean> {
    return withProcessLock(`${this.filePath}.lock.sqlite`, 'registry', async () => {
      const registry = await this.read()
      const remainingProjects = registry.projects.filter((project) => project.id !== id)
      if (remainingProjects.length === registry.projects.length) {
        return false
      }

      registry.projects = remainingProjects
      await this.write(registry)
      return true
    })
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
    atomicWriteText(this.filePath, `${JSON.stringify(registry, null, 2)}\n`)
  }
}

function publicRecord(record: z.infer<typeof projectRegistryRecordSchema>): ProjectRegistryRecord {
  return { id: record.id, name: record.name, description: record.description, rootPath: record.rootPath, lastOpenedAt: record.lastOpenedAt }
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
