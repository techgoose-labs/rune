// The request-validation gateway.
//
// A body-bearing request into the backend is pre-checked here so a malformed,
// oversized, over-nested, or wrong-media-type body becomes a clean 4xx instead
// of a 500 leaking a parser error out of the DI pipeline.
//
// It lived in sprig's `serveSprig`, which meant it guarded a keep backend only
// when a sprig UI happened to be composed in front of it — a backend served on
// its own, or behind any other UI, had no gateway at all. It is keep's now,
// applied by keep's own unit, so it holds on every channel and in every shape.

/** 4 MiB. Larger bodies are rejected before anything tries to parse them. */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;
/** Nesting past this is a parser bomb, not a request. */
export const MAX_JSON_DEPTH = 200;

/** Maximum bracket nesting in `text`, ignoring anything inside a string. */
export function jsonDepth(text: string): number {
  let depth = 0, max = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") {
      if (++depth > max) max = depth;
    } else if (c === "]" || c === "}") depth--;
  }
  return max;
}

/**
 * Check a request's body. Returns the rejecting `Response`, or the request to
 * carry on with — the body is consumed to inspect it, so a checked request is
 * rebuilt around the text that was read.
 *
 * A bodyless request passes through untouched, and so does a body the route
 * space never parses as JSON: the docs control plane streams, and an upgrade
 * has no body at all.
 */
export async function checkBody(req: Request): Promise<Response | Request> {
  if (req.body === null) return req;
  const text = await req.text();
  if (text.length === 0) {
    return new Request(req.url, { method: req.method, headers: req.headers });
  }
  const contentType = (req.headers.get("content-type") ?? "").split(";")[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    return new Response("Unsupported Media Type", { status: 415 });
  }
  if (
    new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES ||
    jsonDepth(text) > MAX_JSON_DEPTH
  ) {
    return new Response("Bad Request", { status: 400 });
  }
  try {
    JSON.parse(text);
  } catch {
    return new Response("Bad Request", { status: 400 });
  }
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: text,
  });
}
