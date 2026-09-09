import { createServer, type Server, type RequestListener } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { afterEach, expect, it } from 'vitest'
import { assertWorkstackBuild, testEndpoint } from '../support/test-server'

const servers: Server[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function serve(handler: RequestListener): Promise<number> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected TCP test address')
  return address.port
}

it('rejects an unrelated application or stale build before feature tests run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-identity-'))
  directories.push(directory)
  const manifestPath = path.join(directory, 'identity.json')
  await writeFile(manifestPath, JSON.stringify({ application: 'workstack', buildId: 'current-build' }))
  let buildId = 'stale-build'
  const port = await serve((request, response) => {
    response.end(request.url === '/workstack-build.json'
      ? JSON.stringify({ application: 'workstack', buildId })
      : `<meta name="workstack-build-id" content="${buildId}">`)
  })
  await expect(assertWorkstackBuild(testEndpoint(String(port)).baseURL, manifestPath)).rejects.toThrow('identity mismatch')
  buildId = 'current-build'
  await expect(assertWorkstackBuild(testEndpoint(String(port)).baseURL, manifestPath)).resolves.toBeUndefined()
})

it('strict preview startup fails on an occupied port and leaves its owner running', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'workstack-preview-'))
  directories.push(directory)
  await writeFile(path.join(directory, 'index.html'), '<title>Workstack test fixture</title>')
  const port = await serve((_request, response) => response.end('unrelated service'))
  const output = await new Promise<{ code: number | null; log: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--config', 'vite.renderer.config.ts', '--outDir', directory, '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
    let log = ''
    child.stdout.on('data', (data: Buffer) => { log += data.toString() })
    child.stderr.on('data', (data: Buffer) => { log += data.toString() })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code, log }))
  })
  expect(output.code).not.toBe(0)
  expect(output.log).toContain(`Port ${port} is already in use`)
  expect(await fetch(testEndpoint(String(port)).baseURL).then((response) => response.text())).toBe('unrelated service')
})
