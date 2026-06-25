import * as zlib from "node:zlib";
import { promisify } from "node:util";

const gunzip = promisify(zlib.gunzip);
const inflate = promisify(zlib.inflate);
const brotliDecompress = promisify(zlib.brotliDecompress);
const zstdDecompress = typeof zlib.zstdDecompress === "function" ? promisify(zlib.zstdDecompress) : null;

export function sendJson(res, statusCode, value) {
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(`${JSON.stringify(value)}\n`);
}

export function sendHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-cache",
  });
  res.end(html);
}

export function sendError(res, statusCode, message, detail) {
  sendJson(res, statusCode, {
    error: {
      message,
      type: "codex_deepseek_bridge_error",
      detail,
    },
  });
}

export function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export async function readJsonBody(req) {
  const rawBody = await readRequestBody(req);
  const body = await decodeRequestBody(rawBody, req.headers);
  if (!body.length) {
    return {};
  }
  try {
    return JSON.parse(body.toString("utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const next = new Error(`invalid JSON body: ${detail}`);
    next.statusCode = 400;
    throw next;
  }
}

async function decodeRequestBody(body, headers = {}) {
  const encoding = String(headers["content-encoding"] || headers["Content-Encoding"] || "identity").trim().toLowerCase();
  if (!body.length || !encoding || encoding === "identity") {
    return body;
  }
  try {
    if (encoding === "gzip" || encoding === "x-gzip") {
      return await gunzip(body);
    }
    if (encoding === "deflate") {
      return await inflate(body);
    }
    if (encoding === "br") {
      return await brotliDecompress(body);
    }
    if (encoding === "zstd" && zstdDecompress) {
      return await zstdDecompress(body);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const next = new Error(`invalid ${encoding} request body: ${detail}`);
    next.statusCode = 400;
    throw next;
  }
  const next = new Error(
    `unsupported request content-encoding: ${encoding}. Disable request compression in Codex or run setup again so the bridge uses its HTTP-only provider.`,
  );
  next.statusCode = 415;
  throw next;
}

export function extractBearer(headers) {
  const auth = headers.authorization || headers.Authorization;
  if (typeof auth !== "string") {
    return "";
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
