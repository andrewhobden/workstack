import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ProjectRegistry } from '../core/project-registry'
import { ProjectsService } from '../core/projects-service'
import { runStdioServer } from '../mcp/server'
import { registerIpcHandlers } from './ipc'
import { OpenAiCompatibleProvider } from './ai-provider'
import { CopilotLauncher } from './copilot-launcher'
import { PullRequestService } from './pull-requests'
import { WikiAutomationService } from './wiki-automation-service'
import { createWindowOptions } from './window-options'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const mcpMode = process.argv.includes('--mcp')

function createWindow(): BrowserWindow {
  const window = new BrowserWindow(createWindowOptions(path.join(__dirname, '../preload/index.cjs')))

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
  const aiProvider = new OpenAiCompatibleProvider(path.join(app.getPath('userData'), 'ai-provider.json'))
  const wikiAutomation = new WikiAutomationService(projects, aiProvider)
  registerIpcHandlers(
    projects,
    aiProvider,
    new CopilotLauncher({
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      temporaryDirectory: app.getPath('temp')
    }),
    new PullRequestService(projects, new CopilotLauncher({
      appPath: app.getAppPath(),
      executablePath: process.execPath,
      isPackaged: app.isPackaged,
      platform: process.platform,
      temporaryDirectory: app.getPath('temp')
    }), undefined, wikiAutomation),
    wikiAutomation
  )
  wikiAutomation.start()
  app.once('before-quit', () => wikiAutomation.stop())
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
