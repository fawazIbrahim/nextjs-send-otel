// Zero-dependency stand-in for Tempo/Mimir's OTLP/HTTP receivers, for local
// development only. Logs every request it receives (method, path,
// content-type, byte size) so you can see traces/metrics arriving, then
// responds 200. Point both OTEL_EXPORTER_OTLP_TRACES_ENDPOINT and
// OTEL_EXPORTER_OTLP_METRICS_ENDPOINT at this same server.
import http from "node:http";

const port = Number(process.env.MOCK_OTLP_PORT) || 4318;

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const bytes = chunks.reduce((total, chunk) => total + chunk.length, 0);
    const contentType = req.headers["content-type"] ?? "(none)";
    const encoding = req.headers["content-encoding"] ?? "-";
    console.log(
      `[mock-otlp] ${req.method} ${req.url}  content-type=${contentType}  content-encoding=${encoding}  bytes=${bytes}`
    );

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
});

server.listen(port, () => {
  console.log(`[mock-otlp] listening on http://localhost:${port}`);
});
