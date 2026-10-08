// Next.js client-lifecycle file: runs after the HTML document loads but before
// React hydration begins.
import { registerBrowserOtel } from "./otel/client";

registerBrowserOtel();
