import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectRegistry } from '../core/project-registry'
import { ProjectsService } from '../core/projects-service'
import { runStdioServer } from '../mcp/server'
import { registerIpcHandlers } from './ipc'
import { OpenAiCompatibleProvider } from './ai-provider'
import { createWindowOptions } from './window-options'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mcpMode = process.argv.includes('--mcp')

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions(path.join(__dirname, '../preload/index.mjs')))

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return window
}

app.whenReady().then(() => {
  const registry = new ProjectRegistry(path.join(app.getPath('userData'), 'projects.json'))
  const projects = new ProjectsService(registry)
  if (mcpMode) {
    return runStdioServer(projects)
  }
  registerIpcHandlers(projects, new OpenAiCompatibleProvider(path.join(app.getPath('userData'), 'ai-provider.json')))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (!mcpMode && process.platform !== 'darwin') {
    app.quit()
  }
})
