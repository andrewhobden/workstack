import { createHash } from 'node:crypto'

export const SOURCE_PASSAGE_LIMITS = { maxCharacters: 4000, maxPassages: 1000, maxResponseCharacters: 24_000, maxResults: 30 } as const
export interface SplitPassage {
  headingTrail: string[]; startLine: number; endLine: number; startOffset: number; endOffset: number; text: string
  passageHash: string; structure: { kind: 'markdown' | 'code'; fence?: string; continued: boolean }
}

/** Structure-aware equivalent splitter: headings are recognized only outside fenced code.
 * All normalized input spans are retained. Oversized blocks continue with explicit fence metadata.
 */
export function splitSourcePassages(text: string, maxCharacters: number = SOURCE_PASSAGE_LIMITS.maxCharacters): SplitPassage[] {
  if (!Number.isSafeInteger(maxCharacters) || maxCharacters < 2) throw new Error('Passage size must be an integer allowing a complete Unicode character.')
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const result: SplitPassage[] = []
  let headingTrail: string[] = []
  let fence: { marker: string; length: number; label: string } | undefined
  let offset = 0
  let startOffset = 0
  let startLine = 1
  let current = ''
  let currentHeading: string[] = []
  let currentStructure: SplitPassage['structure'] = { kind: 'markdown', continued: false }
  let endLine = 1
  const flush = () => {
    if (!current) return
    result.push({ headingTrail: currentHeading, startLine, endLine, startOffset, endOffset: startOffset + current.length, text: current, passageHash: hashSourceText(current), structure: currentStructure })
    if (result.length > SOURCE_PASSAGE_LIMITS.maxPassages) throw new Error(`Source exceeds the ${SOURCE_PASSAGE_LIMITS.maxPassages}-passage limit.`)
    current = ''
  }
  lines.forEach((line, lineIndex) => {
    const heading = !fence && /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n)?$/.exec(line)
    const marker = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(line)
    if (heading) { flush(); headingTrail = [...headingTrail.slice(0, heading[1].length - 1), heading[2].trim()] }
    if (!fence && marker) { flush(); fence = { marker: marker[1][0], length: marker[1].length, label: `${marker[1]}${marker[2].trim()}` } }
    const closing = Boolean(fence && marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && marker[2].trim() === '' && currentStructure.kind === 'code' && (current || currentStructure.continued))
    let position = 0
    while (position < line.length) {
      if (current && current.length + line.length - position > maxCharacters) flush()
      if (!current) {
        startOffset = offset + position
        startLine = lineIndex + 1
        currentHeading = [...headingTrail]
        currentStructure = { kind: fence ? 'code' : 'markdown', ...(fence ? { fence: fence.label } : {}), continued: position > 0 || Boolean(fence && !marker) }
      }
      let length = Math.min(maxCharacters - current.length, line.length - position)
      const boundary = position + length
      if (boundary < line.length && /[\uD800-\uDBFF]/.test(line[boundary - 1]) && /[\uDC00-\uDFFF]/.test(line[boundary])) length -= 1
      // A full pending line is flushed above; an integer bound of at least two
      // leaves a positive span even when a surrogate boundary reduces it by one.
      current += line.slice(position, position + length)
      position += length
      endLine = lineIndex + 1
      if (current.length === maxCharacters) flush()
    }
    offset += line.length
    if (closing) { flush(); fence = undefined; currentStructure = { kind: 'markdown', continued: false } }
    else if (!fence && !line.trim()) flush()
  })
  flush()
  return result
}

export function hashSourceText(text: string): string { return createHash('sha256').update(text).digest('hex') }
export function sourceSearchExpression(query: string): string | undefined {
  const tokens = [...new Set(query.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [])].slice(0, 16)
  return tokens.length ? tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ') : undefined
}
