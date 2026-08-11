import { describe, expect, it } from 'vitest'
import { createWindowOptions } from '../../src/main/window-options'

describe('createWindowOptions', () => {
  it('uses the native macOS titlebar so the window remains draggable', () => {
    const options = createWindowOptions('/tmp/preload.mjs')

    expect(options.titleBarStyle).toBeUndefined()
    expect(options.webPreferences).toMatchObject({
      preload: '/tmp/preload.mjs',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    })
  })
})
