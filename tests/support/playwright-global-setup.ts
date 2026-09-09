import path from 'node:path'
import { assertWorkstackBuild, testEndpoint } from './test-server'

export default async function setup(): Promise<void> {
  await assertWorkstackBuild(testEndpoint().baseURL, path.resolve('dist/web/workstack-build.json'))
}
