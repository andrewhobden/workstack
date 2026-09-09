import { describe, expect, it } from 'vitest'
import { agentExecutionPreflight, requireAgentExecutionProfile } from '../../src/core/execution-profiles'

describe('agent execution capability profiles', () => {
  it('defaults to inspection and fails closed for unenforceable restricted combinations', () => {
    for (const selection of [undefined, 'inspection', 'implementation']) {
      const result = agentExecutionPreflight(selection, '/repo/task-worktree', 'darwin')
      expect(result.supported).toBe(false)
      expect(result.workspacePath).toBe('/repo/task-worktree')
      expect(result.capabilities.network).toBe(false)
      expect(result.capabilities.scope).toBe('workspace')
      expect(result.reason).toContain('cannot be enforced')
      expect(() => requireAgentExecutionProfile(selection, '/repo/task-worktree', 'darwin')).toThrow('No agent will start')
    }
    expect(agentExecutionPreflight('inspection', '/repo', 'darwin').capabilities).toMatchObject({ readFiles: true, writeFiles: false, externalProcesses: false })
    expect(agentExecutionPreflight('implementation', '/repo', 'darwin').capabilities).toMatchObject({ writeFiles: true, externalProcesses: true })
  })

  it('requires an explicit Advanced selection and reports its actual broad access', () => {
    const result = requireAgentExecutionProfile('advanced', '/repo/task-worktree', 'darwin')
    expect(result).toEqual({ profile: 'advanced', supported: true, workspacePath: '/repo/task-worktree', capabilities: { readFiles: true, writeFiles: true, network: true, externalProcesses: true, scope: 'user' } })
    expect(agentExecutionPreflight('advanced', '/repo', 'linux')).toMatchObject({ supported: false, reason: expect.stringContaining('requires macOS') })
    expect(() => requireAgentExecutionProfile('invented-mode', '/repo', 'darwin')).toThrow('Choose a supported agent execution profile')
  })
})
