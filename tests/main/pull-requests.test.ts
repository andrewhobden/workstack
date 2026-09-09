import { describe, expect, it, vi } from 'vitest'
import { PullRequestService } from '../../src/main/pull-requests'

const trackedUrl = 'https://github.com/acme/workstack/pull/1'
const trackedPullRequest = {
  author: { login: 'andrew' }, headRefName: 'feature/wiki', isDraft: false,
  mergeCommit: { oid: 'abc123' }, mergedAt: '2026-08-14T00:00:00.000Z', number: 1,
  state: 'MERGED', title: 'Document merge', updatedAt: '2026-08-14T00:00:01.000Z', url: trackedUrl
}

function projectFixture(status = 'in_progress') {
  const reconcilePullRequestWorkItem = vi.fn(async () => undefined)
  return {
    verifyProjectRoot: async () => '/repository',
    listWorkItems: async () => [{ id: 'work-item-1', displayId: 'WS-1', title: 'Document merge', status }],
    getCompletion: async () => ({ prUrl: trackedUrl }),
    reconcilePullRequestWorkItem
  }
}

describe('PullRequestService', () => {
  it('reconciles directly tracked merged work even when wiki enqueueing fails', async () => {
    const projects = projectFixture()
    const handler = { handleMergedPullRequest: vi.fn(async () => { throw new Error('Wiki provider unavailable') }) }
    const calls: string[][] = []
    const runGh = async (args: string[]) => {
      calls.push(args)
      return JSON.stringify(args[0] === 'api' ? [[]] : trackedPullRequest)
    }
    const service = new PullRequestService(projects as never, {} as never, runGh, handler)
    await expect(service.list('project-1')).resolves.toEqual([])
    expect(projects.reconcilePullRequestWorkItem).toHaveBeenCalledWith('project-1', 'work-item-1', trackedUrl, 'MERGED')
    expect(calls).toContainEqual(['pr', 'view', trackedUrl, '--json', 'number,title,url,headRefName,isDraft,author,updatedAt,state,mergedAt,mergeCommit'])
    expect(handler.handleMergedPullRequest).toHaveBeenCalledOnce()
  })

  it('paginates the open queue independently of closed history and finds old closed or reopened submissions', async () => {
    const projects = projectFixture()
    const page = (offset: number, count: number) => Array.from({ length: count }, (_, index) => ({
      number: offset + index, title: `Open ${offset + index}`, html_url: `https://github.com/acme/workstack/pull/${offset + index}`,
      head: { ref: `feature/${offset + index}` }, draft: false, user: null, updated_at: '2026-08-14T00:00:00.000Z'
    }))
    let trackedState = 'CLOSED'
    const runGh = vi.fn(async (args: string[]) => JSON.stringify(args[0] === 'api' ? [page(2, 100), [...page(101, 1), ...page(102, 17)]] : { ...trackedPullRequest, state: trackedState }))
    const service = new PullRequestService(projects as never, {} as never, runGh)
    const open = await service.list('project-1')
    expect(open).toHaveLength(117)
    expect(open.at(-1)?.number).toBe(118)
    expect(runGh).toHaveBeenCalledWith(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=open&per_page=100'], '/repository')
    expect(projects.reconcilePullRequestWorkItem).toHaveBeenLastCalledWith('project-1', 'work-item-1', trackedUrl, 'CLOSED')
    trackedState = 'OPEN'
    await service.list('project-1')
    expect(projects.reconcilePullRequestWorkItem).toHaveBeenLastCalledWith('project-1', 'work-item-1', trackedUrl, 'OPEN')
  })

  it('does not refetch delivered historical pull requests while listing the queue', async () => {
    const runGh = vi.fn<(args: string[], cwd: string) => Promise<string>>(async () => '[[]]')
    const service = new PullRequestService(projectFixture('completed') as never, {} as never, runGh)
    await expect(service.list('project-1')).resolves.toEqual([])
    expect(runGh).toHaveBeenCalledOnce()
    expect(runGh.mock.calls[0][0]).toEqual(['api', '--paginate', '--slurp', 'repos/{owner}/{repo}/pulls?state=open&per_page=100'])
  })

  it('surfaces inaccessible tracked submissions instead of silently treating them as absent', async () => {
    const runGh = async (args: string[]) => {
      if (args[0] === 'api') return '[[]]'
      throw new Error('Tracked pull request is unavailable')
    }
    const service = new PullRequestService(projectFixture() as never, {} as never, runGh)
    await expect(service.list('project-1')).rejects.toThrow('Tracked pull request is unavailable')
  })
})
