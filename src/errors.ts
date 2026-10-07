// ── API Error boundary ──────────────────────────────────────────────
// Expected request/lookup/precondition failures are classified into HTTP status
// codes so the endpoint catch boundary can return the correct status instead of
// converting everything to 500. Genuinely unexpected failures remain 500.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function isApiError(error: unknown): error is ApiError {
  return error instanceof ApiError;
}

// The TypeScript handbook's exhaustiveness check (Narrowing, "Exhaustiveness checking"):
// a switch arm reaches this only when a union variant has no case.
export function assertNever(value: never): never {
  throw new Error("Unhandled variant: " + JSON.stringify(value));
}
