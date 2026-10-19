// An error with an HTTP status and a short message for the owner. Anything else becomes a 500 with its message
// logged and a generic reply.
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
