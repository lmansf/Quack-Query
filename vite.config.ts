import type { IncomingMessage, ServerResponse } from "node:http";
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from "vite";

type ApiHandler = (request: Request) => Response | Promise<Response>;

/** Request objects Connect hands to middleware carry the un-stripped URL. */
type ConnectRequest = IncomingMessage & { originalUrl?: string };

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

/** Returns a plain ArrayBuffer-backed Uint8Array so it satisfies the Web `BodyInit` type. */
async function readBody(req: IncomingMessage): Promise<Uint8Array<ArrayBuffer>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function toWebHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(key, value);
    else if (Array.isArray(value)) headers.set(key, value.join(", "));
  }
  return headers;
}

function pickHandler(mod: Record<string, unknown>, method: string): ApiHandler | null {
  const named = mod[method.toUpperCase()];
  if (typeof named === "function") return named as ApiHandler;
  const fallback = mod["default"];
  if (typeof fallback === "function") return fallback as ApiHandler;
  return null;
}

/**
 * Serves `api/<name>.ts` at `/api/<name>` during `vite dev`, mimicking the
 * Vercel serverless runtime (Web Request in, Web Response out) without the
 * Vercel CLI. Only active in serve mode.
 */
function localApi(mode: string): Plugin {
  // Load ANTHROPIC_* from .env files once, so api/ modules can read process.env.
  const env = loadEnv(mode, process.cwd(), "ANTHROPIC_");
  for (const [key, value] of Object.entries(env)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return {
    name: "quack-query-local-api",
    apply: "serve",
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req: ConnectRequest, res, next) => {
        const url = req.originalUrl ?? req.url ?? "";
        if (!url.startsWith("/api/")) {
          next();
          return;
        }
        void handleApi(server, req, res, url);
      });
    },
  };
}

async function handleApi(
  server: ViteDevServer,
  req: ConnectRequest,
  res: ServerResponse,
  url: string,
): Promise<void> {
  try {
    const method = (req.method ?? "GET").toUpperCase();
    const pathname = url.split("?")[0] ?? "";
    const name = pathname.slice("/api/".length).replace(/\/+$/, "");
    if (!/^[\w-]+$/.test(name)) {
      sendJson(res, 404, { error: `No API route for ${pathname}` });
      return;
    }

    const mod = (await server.ssrLoadModule(`/api/${name}.ts`)) as Record<string, unknown>;
    const handler = pickHandler(mod, method);
    if (!handler) {
      sendJson(res, 405, { error: `Method ${method} not allowed for /api/${name}` });
      return;
    }

    const init: RequestInit = { method, headers: toWebHeaders(req) };
    if (method !== "GET" && method !== "HEAD") {
      init.body = await readBody(req);
    }
    const request = new Request("http://localhost" + url, init);
    const response = await handler(request);

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    console.error("[local-api]", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: String(err) });
    } else {
      res.end();
    }
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [localApi(mode)],
  optimizeDeps: { exclude: ["@duckdb/duckdb-wasm"] },
}));
