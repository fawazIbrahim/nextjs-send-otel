// Next.js server-lifecycle hook: register() runs once when a new server
// instance starts, before it accepts requests. If you already have this file,
// add the body of the `if` to your existing register().
export async function register() {
  // NodeSDK can't load in the edge runtime, so guard on the Node.js runtime.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerServerOtel } = await import("./otel/server");
    registerServerOtel();
  }
}
