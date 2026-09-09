import path from 'node:path'

const excludedDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'coverage', '.workstack', '.ssh', '.aws'])
export function excludedEvidencePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]+/)
  const name = path.basename(relativePath).toLowerCase()
  return parts.some((part) => excludedDirectories.has(part)) || /^(\.env($|\.)|\.npmrc$|credentials($|\.)|secrets?($|\.)|id_rsa|id_ed25519)/.test(name) || /\.(pem|key|p12|pfx|keystore)$/.test(name)
}

/** Redact common credential forms before reference material crosses a provider boundary. */
export function redactEvidence(content: string): string {
  return content
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED CREDENTIAL]')
    .replace(/((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*["']?\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi, '$1[REDACTED]')
    .replace(/(Authorization\s*:\s*)(?:Bearer|Basic)\s+\S+/gi, '$1[REDACTED]')
}
