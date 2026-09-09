import { useCallback, useEffect, useRef, useState } from 'react'
import type { DesktopApi } from '../../shared/desktop-api'
import type { ProjectMetadata, WorkClaim, WorkItem } from '../../core/types'
import type { KnowledgeSource } from '../../core/knowledge'

interface ProjectSnapshot {
  projectId?: string
  metadata?: ProjectMetadata
  workItems: WorkItem[]
  claims: WorkClaim[]
  knowledgeSources: KnowledgeSource[]
}

const emptySnapshot: ProjectSnapshot = { workItems: [], claims: [], knowledgeSources: [] }

/** All project data shares one selection generation; late responses cannot cross projects. */
export function useProjectSnapshot(api: DesktopApi, projectId: string | undefined, onError: (message: string) => void) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>(emptySnapshot)
  const [loading, setLoading] = useState(false)
  const selection = useRef({ projectId, generation: 0 })
  const inFlight = useRef(new Map<number, Promise<void>>())
  const localReceipts = useRef(new Map<string, WorkItem>())
  const mounted = useRef(true)
  if (selection.current.projectId !== projectId) {
    selection.current = { projectId, generation: selection.current.generation + 1 }
    localReceipts.current.clear()
  }

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const refresh = useCallback((requestedProjectId: string): Promise<void> => {
    const selected = selection.current
    if (selected.projectId !== requestedProjectId) return Promise.resolve()
    const active = inFlight.current.get(selected.generation)
    if (active) return active
    const isCurrent = (): boolean => mounted.current && selection.current === selected
    const request = (async () => {
      setLoading(true)
      try {
        const [metadata, workItems, claims, knowledgeSources] = await Promise.all([
          api.projects.get(requestedProjectId),
          api.workItems.list(requestedProjectId),
          api.claims.list(requestedProjectId),
          api.knowledge.listSources(requestedProjectId)
        ])
        if (isCurrent()) {
          const reconciled = workItems.map((item) => {
            const receipt = localReceipts.current.get(item.id)
            if (receipt && receipt.updatedAt > item.updatedAt) return receipt
            localReceipts.current.delete(item.id)
            return item
          })
          setSnapshot({ projectId: requestedProjectId, metadata, workItems: reconciled, claims, knowledgeSources })
        }
      } catch (error) {
        if (isCurrent()) onError(error instanceof Error ? error.message : String(error))
      } finally {
        inFlight.current.delete(selected.generation)
        if (isCurrent()) setLoading(false)
      }
    })()
    inFlight.current.set(selected.generation, request)
    return request
  }, [api, onError])

  useEffect(() => {
    if (!projectId) return
    let active = true
    let timer: number | undefined
    const poll = async (): Promise<void> => {
      await refresh(projectId)
      if (active) timer = window.setTimeout(() => void poll(), 5_000)
    }
    void poll()
    return () => {
      active = false
      window.clearTimeout(timer)
    }
  }, [projectId, refresh])

  const updateItem = useCallback((item: WorkItem): void => {
    localReceipts.current.set(item.id, item)
    setSnapshot((current) => current.projectId === selection.current.projectId
      ? { ...current, workItems: current.workItems.map((existing) => existing.id === item.id ? item : existing) }
      : current)
  }, [])

  return { ...(snapshot.projectId === projectId ? snapshot : emptySnapshot), loading, refresh, updateItem }
}
