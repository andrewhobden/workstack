import { ProjectStore } from '../../src/core/project-store'
import { ClaimsRepository } from '../../src/core/claims'
import { TaskDependenciesRepository } from '../../src/core/task-dependencies'

async function main(): Promise<void> {
  const [mode, root, taskId, prerequisiteId] = process.argv.slice(2)
  const store = await ProjectStore.open(root)
  try {
    if (mode === 'hold-edit') {
      store.database.exec('BEGIN IMMEDIATE')
      new TaskDependenciesRepository(store).update(taskId, { dependsOn: [prerequisiteId] })
      process.send?.({ ready: true })
      await new Promise<void>((resolve) => process.once('message', () => resolve()))
      store.database.exec('COMMIT')
    } else {
      process.send?.({ ready: true })
      await new Promise<void>((resolve) => process.once('message', () => resolve()))
      if (mode === 'edit') new TaskDependenciesRepository(store).update(taskId, { dependsOn: [prerequisiteId] })
      else new ClaimsRepository(store).claim(taskId, { agentId: 'concurrent-worker' })
    }
    process.stdout.write(JSON.stringify({ succeeded: true }))
  } catch (reason) {
    const error = reason as { code?: string; message: string }
    if (store.database.inTransaction) store.database.exec('ROLLBACK')
    process.stdout.write(JSON.stringify({ succeeded: false, code: error.code, message: error.message }))
  } finally { store.close() }
}

main().catch((reason) => { process.stderr.write(String(reason)); process.exitCode = 1 })
