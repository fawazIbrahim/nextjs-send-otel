import type { ApiError } from "@/lib/types";
import { CORRELATION_ID_HEADER, sanitizeId } from "@/lib/request-ids";
import { getRemoteBaseUrl } from "../config";
import { NotFoundError, UpstreamError } from "../errors";
import { createRemoteClient } from "../remote/client";
import { createProductsService } from "./products-service";

/** Builds the service for a request, propagating its correlation id to the remote service. */
export const productsServiceFor = (request: Request) =>
  createProductsService(
    createRemoteClient(
      getRemoteBaseUrl(new URL(request.url).origin),
      sanitizeId(request.headers.get(CORRELATION_ID_HEADER)),
    ),
  );

/** Maps domain errors to safe HTTP responses (no internals leaked). */
export function errorResponse(err: unknown): Response {
  if (err instanceof NotFoundError) {
    const body: ApiError = { error: { code: err.code, message: err.message } };
    return Response.json(body, { status: err.status });
  }
  if (err instanceof UpstreamError) {
    console.error("[bff] upstream error:", err.message, err.cause);
    const body: ApiError = { error: { code: err.code, message: "Service temporarily unavailable" } };
    return Response.json(body, { status: err.status });
  }
  console.error("[bff] unexpected error:", err);
  const body: ApiError = { error: { code: "INTERNAL_ERROR", message: "Unexpected error" } };
  return Response.json(body, { status: 500 });
}
