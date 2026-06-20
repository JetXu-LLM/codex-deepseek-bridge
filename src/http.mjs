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
  const body = await readRequestBody(req);
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

export function extractBearer(headers) {
  const auth = headers.authorization || headers.Authorization;
  if (typeof auth !== "string") {
    return "";
  }
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}
