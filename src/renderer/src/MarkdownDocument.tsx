import { createElement, type ReactNode } from 'react'

// Content is rendered as React text, never HTML. Unknown Markdown remains readable.
function inline(text: string): ReactNode[] {
  const tokens = text.split(/(`[^`]+`|\[[^\]]+\]\([^\s)]+\)|\*\*[^*]+\*\*|\*[^*]+\*)/g)
  return tokens.map((token, index) => {
    if (token.startsWith('`') && token.endsWith('`')) return <code key={index}>{token.slice(1, -1)}</code>
    if (token.startsWith('**') && token.endsWith('**')) return <strong key={index}>{token.slice(2, -2)}</strong>
    if (token.startsWith('*') && token.endsWith('*')) return <em key={index}>{token.slice(1, -1)}</em>
    const link = token.match(/^\[([^\]]+)\]\(([^\s)]+)\)$/)
    if (link) {
      const safe = /^(https?:\/\/|mailto:|#|\.?\.?\/)/i.test(link[2])
      return safe ? <a key={index} href={link[2]} target="_blank" rel="noreferrer noopener">{link[1]}</a> : link[1]
    }
    return token
  })
}

export function MarkdownDocument({ content }: { content: string }): JSX.Element {
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    const key = index
    if (!line.trim()) { index++; continue }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/)
    if (fence) {
      const body: string[] = []
      index++
      while (index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index++])
      index++
      blocks.push(<pre key={key}><code data-language={fence[2].trim() || undefined}>{body.join('\n')}</code></pre>)
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) { blocks.push(createElement(`h${heading[1].length}`, { key }, inline(heading[2]))); index++; continue }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { blocks.push(<hr key={key} />); index++; continue }
    const list = line.match(/^\s*(?:([-+*])|\d+\.)\s+(.+)$/)
    if (list) {
      const ordered = !list[1]
      const entries: ReactNode[] = []
      while (index < lines.length) {
        const entry = lines[index].match(/^\s*(?:([-+*])|\d+\.)\s+(.+)$/)
        if (!entry || Boolean(entry[1]) === ordered) break
        entries.push(<li key={index}>{inline(entry[2])}</li>)
        index++
      }
      blocks.push(ordered ? <ol key={key}>{entries}</ol> : <ul key={key}>{entries}</ul>)
      continue
    }
    if (/^>\s?/.test(line)) {
      const body: string[] = []
      while (index < lines.length && /^>\s?/.test(lines[index])) body.push(lines[index++].replace(/^>\s?/, ''))
      blocks.push(<blockquote key={key}>{inline(body.join('\n'))}</blockquote>)
      continue
    }
    const body = [line]
    index++
    while (index < lines.length && lines[index].trim() && !/^(#{1,6}\s|\s*(`{3,}|~{3,}|[-+*]\s|\d+\.\s)|>)/.test(lines[index])) body.push(lines[index++])
    blocks.push(<p key={key}>{inline(body.join('\n'))}</p>)
  }
  return <div className="markdown-document">{blocks}</div>
}
