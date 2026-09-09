import { ProjectStore } from '../../src/core/project-store'
import { ProjectRegistry } from '../../src/core/project-registry'
import { WorkItemRepository } from '../../src/core/work-items'
import { ArtifactStore } from '../../src/core/artifact-store'
import { beginProjectDeletion } from '../../src/core/project-lifecycle'

async function main(): Promise<void> {
  const [mode, target, argument] = process.argv.slice(2)
  if (mode === 'registry') {
    const registry = new ProjectRegistry(target)
    const operation = JSON.parse(argument)
    if (operation.remove) await registry.remove(operation.remove)
    else if (operation.refresh) await registry.refresh(operation.refresh)
    else await registry.register(operation.register)
    return
  }
  if (mode === 'delete-preparation' || mode === 'delete-removing') {
    const barrier = await beginProjectDeletion(target)
    if (mode === 'delete-removing') barrier.removing(argument)
    process.send?.({ ready: true })
    await new Promise(() => { setInterval(() => undefined, 1000) })
    return
  }
  const store = await ProjectStore.open(target)
  try {
    if (mode === 'open') { process.stdout.write(JSON.stringify({ id: store.project.id })); return }
    process.send?.({ ready: true })
    await new Promise<void>((resolve) => process.once('message', () => resolve()))
    if (mode === 'update') await store.updateMetadata(JSON.parse(argument))
    if (mode === 'hold-writer') {
      const item = new WorkItemRepository(store).create({ title: 'Committed after deletion began' })
      new ArtifactStore(store).attachBytes(item.id, { originalFilename: 'evidence.txt', mimeType: 'text/plain', data: Buffer.from('accepted operation evidence') })
      process.send?.({ itemId: item.id })
    }
  } finally { store.close() }
}

main().catch((error) => { process.stdout.write(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1 })
