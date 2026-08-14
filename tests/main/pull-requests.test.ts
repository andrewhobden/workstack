import { describe, expect, it, vi } from 'vitest'
import { PullRequestService } from '../../src/main/pull-requests'

describe('PullRequestService', () => {
  it('finalizes merged work even when wiki generation enqueueing fails', async () => {
    const finalizeMergedPullRequestWorkItem = vi.fn(async () => undefined)
    const handler = {
      handleMergedPullRequest: vi.fn(async () => {
        throw new Error('Wiki provider unavailable')
      })
    }
    const projects = {
      verifyProjectRoot: async () => '/repository',
      listWorkItems: async () => [{ id: 'work-item-1', displayId: 'WS-1', title: 'Document merge', status: 'in_progress' }],
      getCompletion: async () => ({ prUrl: 'https://github.com/acme/workstack/pull/1' }),
      finalizeMergedPullRequestWorkItem
    }
    const runGh = async () => JSON.stringify([{
      author: { login: 'andrew' },
      headRefName: 'feature/wiki',
      isDraft: false,
      mergeCommit: { oid: 'abc123' },
      mergedAt: '2026-08-14T00:00:00.000Z',
      number: 1,
      state: 'MERGED',
      title: 'Document merge',
      updatedAt: '2026-08-14T00:00:01.000Z',
      url: 'https://github.com/acme/workstack/pull/1'
    }])
    const service = new PullRequestService(projects as never, {} as never, runGh, handler)

    await expect(service.list('project-1')).resolves.toEqual([])

    expect(finalizeMergedPullRequestWorkItem).toHaveBeenCalledWith('project-1', 'work-item-1')
    expect(handler.handleMergedPullRequest).toHaveBeenCalledOnce()
  })
})
