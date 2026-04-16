export interface MingyuErrorPayload {
  messageKey?: string
  messageParams?: Record<string, string | number>
}

export interface MingyuErrorResponse extends MingyuErrorPayload {
  status: 'error'
  message: string
}

export const buildErrorResponse = (error: unknown): MingyuErrorResponse => {
  const err = error as { message?: string } & MingyuErrorPayload
  return {
    status: 'error',
    message: err?.message || String(error),
    messageKey: err?.messageKey,
    messageParams: err?.messageParams
  }
}
