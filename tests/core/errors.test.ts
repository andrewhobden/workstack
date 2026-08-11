import { describe, expect, it } from 'vitest'
import { WorkstackError } from '../../src/core/errors'

describe('WorkstackError', () => {
  it('keeps a stable machine-readable error code', () => {
    const error = new WorkstackError('CLAIM_TOKEN_INVALID', 'The supplied claim token is no longer valid.')

    expect(error).toMatchObject({
      name: 'WorkstackError',
      code: 'CLAIM_TOKEN_INVALID',
      message: 'The supplied claim token is no longer valid.'
    })
  })
})
