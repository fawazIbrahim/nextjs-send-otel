import { headers } from "next/headers";
import { trace, SpanStatusCode, type Attributes, type Span } from "@opentelemetry/api";
import { CORRELATION_ID_HEADER, REQUEST_ID_HEADER } from "@/lib/request-ids";

// Helper for app-defined spans. Auto-instrumentation and Next already produce
// generic spans (one per request and per fetch); withSpan() wraps a specific
// piece of application logic as its own named, nested span, so a trace
// waterfall shows what the app was doing, not just that an HTTP call happened.

const TRACER_NAME = "safe-insurance";

export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T> | T,
  attributes?: Attributes
): Promise<T> {
  const ids = await currentRequestIds();
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, { attributes: { ...ids, ...attributes } }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.recordException(error instanceof Error ? error : String(error));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      span.end();
    }
  });
}

// request.id / correlation.id of the incoming request being served, so custom
// spans can be found by either id. headers() throws outside a request scope
// (e.g. background work), in which case there are none.
async function currentRequestIds(): Promise<Attributes> {
  try {
    const incoming = await headers();
    const ids: Attributes = {};
    const requestId = incoming.get(REQUEST_ID_HEADER);
    const correlationId = incoming.get(CORRELATION_ID_HEADER);
    if (requestId) ids["request.id"] = requestId;
    if (correlationId) ids["correlation.id"] = correlationId;
    return ids;
  } catch {
    return {};
  }
}
