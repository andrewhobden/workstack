export const ERROR_CODES = [
  'PROJECT_NOT_FOUND',
  'WORK_ITEM_NOT_FOUND',
  'WORK_ITEM_NOT_CLAIMABLE',
  'CLAIM_TOKEN_INVALID',
  'CLAIM_EXPIRED',
  'INVALID_STATE_TRANSITION',
  'ATTACHMENT_NOT_FOUND',
  'VALIDATION_ERROR',
  'STORE_BUSY',
  'INTERNAL_ERROR'
] as const

export type WorkstackErrorCode = (typeof ERROR_CODES)[number]

export class WorkstackError extends Error {
  readonly code: WorkstackErrorCode

  constructor(code: WorkstackErrorCode, message: string) {
    super(message)
    this.name = 'WorkstackError'
    this.code = code
  }
}
