/** An error that is the user's problem, not a bug: printed without a stack trace. */
export class SkbError extends Error {
  hint: string | undefined

  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'SkbError'
    this.hint = hint
  }
}

export function isSkbError(err: unknown): err is SkbError {
  return err instanceof SkbError
}
