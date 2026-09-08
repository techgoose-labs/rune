import { assert, assertEquals, assertRejects } from "#std/assert";
import { frameLspMessages, Lsp } from "./mod.ts";

const enc = new TextEncoder();

/** Build a framed LSP message: `Content-Length: <bytes>\r\n\r\n<body>`. The
 * length is the BODY's UTF-8 byte length (LSP spec), which differs from the
 * JS string length for any non-ASCII content. */
function frame(body: string): Uint8Array {
  const bodyBytes = enc.encode(body);
  const header = enc.encode(`Content-Length: ${bodyBytes.byteLength}\r\n\r\n`);
  const out = new Uint8Array(header.byteLength + bodyBytes.byteLength);
  out.set(header, 0);
  out.set(bodyBytes, header.byteLength);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}

Deno.test("frameLspMessages — ASCII single message frames cleanly", () => {
  const body = `{"jsonrpc":"2.0","id":1,"result":null}`;
  const { bodies, rest } = frameLspMessages(frame(body));
  assertEquals(bodies, [body]);
  assertEquals(rest.byteLength, 0);
});

Deno.test("frameLspMessages — multibyte body (em-dash) does not overshoot", () => {
  // The em-dash `—` is 3 UTF-8 bytes but 1 UTF-16 code unit. A byte length used
  // to slice a decoded string overshoots past the body end.
  const body =
    `{"jsonrpc":"2.0","method":"window/logMessage","params":{"message":"undeclared service — declare it"}}`;
  const { bodies, rest } = frameLspMessages(frame(body));
  assertEquals(bodies, [body], "the multibyte body must be recovered intact");
  assertEquals(rest.byteLength, 0, "no trailing bytes should be stranded");
});

Deno.test("frameLspMessages — multibyte message followed by another stays in sync", () => {
  const a =
    `{"jsonrpc":"2.0","method":"window/logMessage","params":{"message":"x — y"}}`;
  const b = `{"jsonrpc":"2.0","id":3,"result":{"contents":"hover"}}`;
  const { bodies, rest } = frameLspMessages(concat(frame(a), frame(b)));
  assertEquals(
    bodies,
    [a, b],
    "both messages must be recovered; the em-dash must not desync the stream",
  );
  assertEquals(rest.byteLength, 0);
});

Deno.test("frameLspMessages — incomplete trailing message is left as rest", () => {
  const a = `{"jsonrpc":"2.0","id":1,"result":null}`;
  const full = concat(frame(a), frame("partial"));
  // Truncate the second body by 3 bytes.
  const truncated = full.slice(0, full.byteLength - 3);
  const { bodies, rest } = frameLspMessages(truncated);
  assertEquals(bodies, [a]);
  // The partial second frame's header + leftover body bytes remain buffered.
  assertEquals(rest.byteLength > 0, true);
});

// ---- L3: request() must fail fast on a broken pipe, not hang to timeout ----
// request() calls send() without await/catch. send() rejects on a broken pipe /
// closed writer. That floating rejection (a) becomes an uncaught promise that
// can crash the host process and (b) leaves the request promise unsettled until
// timeoutMs (10s in prod). It must instead reject immediately and clear the
// pending entry.

/** A WritableStreamDefaultWriter stub whose write() always rejects — simulates
 * a dead LSP child / broken stdin pipe. */
function brokenWriter(): WritableStreamDefaultWriter<Uint8Array> {
  return {
    write: () => Promise.reject(new Error("Broken pipe / writer closed")),
    close: () => Promise.resolve(),
    abort: () => Promise.resolve(),
    releaseLock: () => {},
    get closed() {
      return Promise.resolve();
    },
    get desiredSize() {
      return 1;
    },
    get ready() {
      return Promise.resolve();
    },
  } as unknown as WritableStreamDefaultWriter<Uint8Array>;
}

Deno.test("request — rejects fast on a broken writer and clears the pending entry", async () => {
  const lsp = new Lsp("/fake", { command: "x", args: [] }) as unknown as {
    writer: WritableStreamDefaultWriter<Uint8Array> | null;
    pending: Map<number, unknown>;
    request: (m: string, p: unknown, t?: number) => Promise<unknown>;
  };
  lsp.writer = brokenWriter();

  const TIMEOUT_MS = 5_000;
  const start = performance.now();
  const err = await assertRejects(
    () => lsp.request("initialize", {}, TIMEOUT_MS),
    Error,
  );
  const elapsed = performance.now() - start;

  // Must fail with the send/pipe error, NOT the slow timeout path.
  assert(
    !/timed out/i.test(err.message),
    `should reject with the pipe error, not the timeout: ${err.message}`,
  );
  // Must settle well under the timeout (fast-fail, not stall the full window).
  assert(
    elapsed < TIMEOUT_MS / 2,
    `request should fail fast, took ${elapsed}ms`,
  );
  // The pending entry must be cleared so it can't leak/double-settle.
  assertEquals(
    lsp.pending.size,
    0,
    "pending entry must be cleared on send failure",
  );
});

Deno.test("frameLspMessages — a complete multibyte msg as the LAST in buffer is delivered", () => {
  // Regression for the WOULD-BLOCK case: with byte length used on a UTF-16
  // string, buffer.length < bodyEnd would be true forever and the message would
  // never be delivered.
  const body = `{"id":2,"result":"diagnostic — boundary"}`;
  const { bodies } = frameLspMessages(frame(body));
  assertEquals(bodies, [body]);
});
