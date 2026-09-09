import { WorkstackError } from './errors'

export const AGENT_EXECUTION_PROFILES = ['inspection', 'implementation', 'advanced'] as const
export type AgentExecutionProfile = (typeof AGENT_EXECUTION_PROFILES)[number]

export interface AgentExecutionPreflight {
  profile: AgentExecutionProfile
  supported: boolean
  workspacePath: string
  capabilities: {
    readFiles: boolean
    writeFiles: boolean
    network: boolean
    externalProcesses: boolean
    scope: 'workspace' | 'user'
  }
  reason?: string
}

/**
 * Copilot 1.0.83 documents permission prompts separately from isolation. Its
 * experimental command sandbox does not provide a verified boundary for all
 * file tools, inherited hooks, MCP servers, and credentials. Do not translate a
 * restricted profile into unrestricted execution or claim that -C isolates it.
 */
export function agentExecutionPreflight(
  requestedProfile: unknown,
  workspacePath: string,
  platform: NodeJS.Platform
): AgentExecutionPreflight {
  const profile = requestedProfile ?? 'inspection'
  if (!AGENT_EXECUTION_PROFILES.includes(profile as AgentExecutionProfile)) {
    throw new WorkstackError('VALIDATION_ERROR', 'Choose a supported agent execution profile.')
  }
  const selected = profile as AgentExecutionProfile
  const preflight: AgentExecutionPreflight = {
    profile: selected,
    supported: platform === 'darwin' && selected === 'advanced',
    workspacePath,
    capabilities: {
      readFiles: true,
      writeFiles: selected !== 'inspection',
      network: selected === 'advanced',
      externalProcesses: selected !== 'inspection',
      scope: selected === 'advanced' ? 'user' : 'workspace'
    }
  }
  if (platform !== 'darwin') {
    preflight.reason = 'Launching Copilot from Workstack currently requires macOS and Terminal.'
  } else if (selected !== 'advanced') {
    preflight.reason = `The ${selected} profile cannot be enforced by this Workstack Copilot adapter. No agent will start. Use knowledge chat inspection for enforced project reads, or explicitly select Advanced in project settings if you intend to grant the agent your user account’s filesystem, network, credentials, and process access.`
  }
  return preflight
}

export function requireAgentExecutionProfile(requestedProfile: unknown, workspacePath: string, platform: NodeJS.Platform): AgentExecutionPreflight {
  const preflight = agentExecutionPreflight(requestedProfile, workspacePath, platform)
  if (!preflight.supported) throw new WorkstackError('VALIDATION_ERROR', preflight.reason!)
  return preflight
}
