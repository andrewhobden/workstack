import type { SourcePolicy } from './source-catalog'
export interface SourceIntakeLimits {
  maxInventoryFiles: number; maxFiles: number; maxFileBytes: number; maxTotalBytes: number
  maxGithubSources: number; maxGithubComments: number; maxGithubPages: number; maxTextCharacters: number
}
export interface SourceInventoryEntry {
  path: string; kind: 'documentation' | 'configuration' | 'code' | 'other'; sizeBytes: number
  suggested: boolean; excludedReason?: string
}
export interface SourceInventory {
  entries: SourceInventoryEntry[]; commit?: string; limited: boolean; diagnostics: string[]; limits: SourceIntakeLimits
}
export interface SourceImportSelection { paths: string[]; githubUrls?: string[]; policy?: SourcePolicy; workItemId?: string }
