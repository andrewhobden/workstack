import type { BrowserWindowConstructorOptions } from 'electron'

export function createWindowOptions(preload: string): BrowserWindowConstructorOptions {
  return {
    width: 1440,
    height: 1000,
    minWidth: 1100,
    minHeight: 720,
    backgroundColor: '#F7F8FB',
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  }
}
