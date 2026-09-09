import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ProjectStore } from '../../src/core/project-store'
import { SemanticIndexRepository, SEMANTIC_LIMITS } from '../../src/core/semantic-index'

const state = vi.hoisted(() => ({ behavior: 'error' as 'error' | 'exit' | 'zero' | 'timeout', options: undefined as Record<string, unknown> | undefined }))
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  constructor(_program: string, options: Record<string, unknown>) {
    super(); state.options = options
    queueMicrotask(() => { if (state.behavior === 'error') this.emit('error', new Error('Worker memory allocation failed.')); if (state.behavior === 'exit') this.emit('exit', 1); if (state.behavior === 'zero') this.emit('exit', 0) })
  }
  async terminate(): Promise<number> { this.emit('exit', 1); return 1 }
} }))
const roots: string[] = []; const stores: ProjectStore[] = []
afterEach(async () => { vi.useRealTimers(); stores.splice(0).forEach((store) => store.close()); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
it('bounds worker memory and elapsed time and rejects failed exits without changing disabled settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workstack-worker-budget-')); roots.push(root)
  const store = await ProjectStore.initialize({ rootPath: root, name: 'Worker budget' }); stores.push(store)
  const index = new SemanticIndexRepository(store)
  await expect(index.configure(path.join(root, 'unused.json'))).rejects.toThrow('memory allocation failed')
  expect(state.options).toMatchObject({ eval: true, resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }, workerData: { operation: 'inspect', limits: SEMANTIC_LIMITS } })
  state.behavior = 'exit'
  await expect(index.configure(path.join(root, 'unused.json'))).rejects.toThrow('stopped before completing')
  vi.useFakeTimers()
  for (const behavior of ['timeout', 'zero'] as const) {
    state.behavior = behavior
    const result = index.configure(path.join(root, 'unused.json')).catch((error: Error) => error)
    await vi.advanceTimersByTimeAsync(3000)
    expect(await result).toMatchObject({ message: expect.stringContaining('3-second time budget') })
  }
  expect(index.status().enabled).toBe(false)
})
