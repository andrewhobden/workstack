import { afterEach, expect, it, vi } from 'vitest'
import { getDesktopApi } from '../../src/renderer/src/api'

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('rejects a missing production preload bridge and permits only an explicit browser demo', () => {
  vi.stubGlobal('window', {})
  vi.stubEnv('VITE_WORKSTACK_BROWSER_DEMO', 'false')
  expect(() => getDesktopApi()).toThrow('could not load its desktop bridge')
  vi.stubEnv('VITE_WORKSTACK_BROWSER_DEMO', 'true')
  expect(getDesktopApi().projects.create).toBeTypeOf('function')
  const bridge = { projects: {} }
  vi.stubGlobal('window', { workstack: bridge })
  vi.stubEnv('VITE_WORKSTACK_BROWSER_DEMO', 'false')
  expect(getDesktopApi()).toBe(bridge)
})
