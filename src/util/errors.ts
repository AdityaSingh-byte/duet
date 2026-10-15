/** An error meant for the person or agent running duet: the message says what to do next. */
export class DuetError extends Error {
  constructor(
    message: string,
    readonly code: 'usage' | 'device' | 'guard' | 'not-found' | 'timeout' | 'failed' = 'failed',
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DuetError';
  }
}

export const exitCodes: Record<DuetError['code'], number> = {
  failed: 1,
  usage: 2,
  guard: 3,
  device: 4,
  'not-found': 5,
  timeout: 6,
};
