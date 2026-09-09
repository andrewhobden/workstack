import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runBashCommand } from '../../src/core/knowledge-chat'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

afterEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
})

function createProcess() {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn()
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  return child
}

describe('Bash command process lifecycle', () => {
  it('preserves exit status and bounds each output stream across multiple chunks', async () => {
    const child = createProcess()
    const result = runBashCommand({ command: 'fixture-command', cwd: '/fixture/project' })
    expect(spawn).toHaveBeenCalledWith('/bin/bash', ['-lc', 'fixture-command'], { cwd: '/fixture/project', stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    child.stdout.emit('data', Buffer.from('first\n'))
    child.stdout.emit('data', Buffer.from('x'.repeat(7000)))
    child.stderr.emit('data', Buffer.from('error\n'))
    child.stderr.emit('data', Buffer.from('e'.repeat(7000)))
    child.emit('close', 7, null)
    expect(await result).toEqual({
      command: 'fixture-command', cwd: '/fixture/project', exitCode: 7, signal: null, timedOut: false,
      stdout: `first\n${'x'.repeat(5994)}`, stderr: `error\n${'e'.repeat(5994)}`
    })
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('terminates a stalled command at the deadline and retains its partial output', async () => {
    vi.useFakeTimers()
    const child = createProcess()
    child.kill.mockImplementation((signal: string) => { child.emit('close', null, signal); return true })
    const result = runBashCommand({ command: 'stalled-fixture', cwd: '/fixture/project' })
    child.stdout.emit('data', Buffer.from('partial result'))
    await vi.advanceTimersByTimeAsync(59_999)
    expect(child.kill).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(await result).toMatchObject({ exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: 'partial result' })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports process startup failure and removes its deadline timer', async () => {
    vi.useFakeTimers()
    const child = createProcess()
    const result = runBashCommand({ command: 'unavailable-fixture', cwd: '/fixture/project' })
    const failed = expect(result).rejects.toMatchObject({ code: 'INTERNAL_ERROR', message: 'Unable to run Bash: fixture spawn denied' })
    child.emit('error', new Error('fixture spawn denied'))
    await failed
    expect(vi.getTimerCount()).toBe(0)
    expect(child.kill).not.toHaveBeenCalled()
  })

  it('refuses a precancelled command without spawning a process', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(runBashCommand({ command: 'unused', cwd: '/fixture', signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(spawn).not.toHaveBeenCalled()
  })

  it('cancels a running command and retains bounded partial output in the failure audit', async () => {
    vi.useFakeTimers()
    const child = createProcess()
    const controller = new AbortController()
    child.kill.mockImplementation((signal: string) => { child.emit('close', null, signal); return true })
    const result = runBashCommand({ command: 'active-command', cwd: '/fixture', signal: controller.signal })
    const failed = expect(result).rejects.toMatchObject({ code: 'CANCELLED', partialResult: { stdout: 'partial evidence', timedOut: false, signal: 'SIGTERM' } })
    child.stdout.emit('data', Buffer.from('partial evidence'))
    controller.abort()
    await failed
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('escalates termination of the owned process group when a command ignores the first signal', async () => {
    vi.useFakeTimers()
    const child = Object.assign(createProcess(), { pid: 12345 })
    const controller = new AbortController()
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => { if (signal === 'SIGKILL') child.emit('close', null, signal); return true })
    try {
      const result = runBashCommand({ command: 'stubborn-command', cwd: '/fixture', signal: controller.signal })
      const failed = expect(result).rejects.toMatchObject({ code: 'CANCELLED', partialResult: { timedOut: true, signal: 'SIGKILL' } })
      await vi.advanceTimersByTimeAsync(60_000)
      controller.abort()
      expect(kill).toHaveBeenCalledExactlyOnceWith(-12345, 'SIGTERM')
      await vi.advanceTimersByTimeAsync(2000)
      await failed
      expect(kill).toHaveBeenLastCalledWith(-12345, 'SIGKILL')
      expect(child.kill).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally { kill.mockRestore() }
  })

  it('handles cancellation during spawn and falls back to the owned child when its process group is unavailable', async () => {
    vi.useFakeTimers()
    const child = Object.assign(createProcess(), { pid: 12345 })
    const controller = new AbortController()
    vi.mocked(spawn).mockImplementation(() => { controller.abort(); return child as unknown as ReturnType<typeof spawn> })
    child.kill.mockImplementation((signal: string) => { child.emit('close', null, signal); return true })
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => { throw new Error('Group already unavailable') })
    try {
      await expect(runBashCommand({ command: 'spawn-race', cwd: '/fixture', signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' })
      expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
      expect(vi.getTimerCount()).toBe(0)
    } finally { kill.mockRestore() }
  })
})
