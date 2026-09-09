import { readFile } from 'node:fs/promises'

export function testEndpoint(portValue = process.env.WORKSTACK_TEST_PORT ?? '42817'): { port: number; baseURL: string } {
  const port = Number(portValue)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('WORKSTACK_TEST_PORT must be an integer from 1024 to 65535.')
  return { port, baseURL: `http://127.0.0.1:${port}` }
}

export async function assertWorkstackBuild(baseURL: string, expectedPath: string): Promise<void> {
  const expected = JSON.parse(await readFile(expectedPath, 'utf8')) as { application: string; buildId: string }
  const [manifest, html] = await Promise.all([
    fetch(`${baseURL}/workstack-build.json`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.json()),
    fetch(baseURL, { signal: AbortSignal.timeout(5_000) }).then((response) => response.text())
  ]).catch((error: unknown) => { throw new Error(`Unable to verify the Workstack test environment at ${baseURL}. The server did not return a valid Workstack build identity.`, { cause: error }) })
  if (expected.application !== 'workstack' || !expected.buildId || manifest.application !== 'workstack'
    || manifest.buildId !== expected.buildId || !html.includes(`name="workstack-build-id" content="${expected.buildId}"`)) {
    throw new Error(`Workstack test environment identity mismatch at ${baseURL}. Build the renderer and use a dedicated WORKSTACK_TEST_PORT.`)
  }
}
