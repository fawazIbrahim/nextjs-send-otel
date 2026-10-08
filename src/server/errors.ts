export class NotFoundError extends Error {
  readonly status = 404;
  readonly code = "NOT_FOUND";
}

export class UpstreamError extends Error {
  readonly status = 502;
  readonly code = "UPSTREAM_ERROR";
}
