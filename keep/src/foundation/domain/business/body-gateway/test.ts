// The request-validation gateway. This suite moved here from sprig with its
// subject: the gateway used to live in `serveSprig`, which meant it guarded a
// keep backend only when a sprig UI happened to be composed in front of it. A
// backend served on its own, or behind any other UI, had no gateway at all.
//
// The byte-cap case below is a real bug that was found and fixed here (the cap
// is documented in BYTES but was enforced with `String.length`, i.e. UTF-16
// code units — so a body of emoji could be ~2× the 4 MiB cap and pass). It is
// kept verbatim, because the class of mistake is easy to reintroduce.

import { assert, assertEquals } from "#assert";
import { checkBody, jsonDepth, MAX_BODY_BYTES, MAX_JSON_DEPTH } from "./mod.ts";

function jsonReq(body: string, contentType = "application/json"): Request {
  return new Request("http://app/api/echo", {
    method: "POST",
    headers: { "content-type": contentType },
    body,
  });
}

Deno.test("a body over the BYTE cap (but under the UTF-16 length cap) is rejected 400", async () => {
  // 😀 (U+1F600): 2 UTF-16 code units, 4 UTF-8 bytes. Build a JSON string of N
  // emoji where the UTF-16 length is under the cap but the UTF-8 size is over:
  // 2N + 2 <= MAX_BODY_BYTES AND 4N + 2 > MAX_BODY_BYTES.
  const body = '"' + "\u{1F600}".repeat(1_500_000) + '"';
  assert(
    body.length <= MAX_BODY_BYTES,
    `UTF-16 length ${body.length} must be <= cap`,
  );
  assert(
    new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES,
    "UTF-8 byteLength must exceed cap",
  );

  const verdict = await checkBody(jsonReq(body));
  assert(
    verdict instanceof Response,
    "oversized-by-bytes body must be rejected",
  );
  assertEquals(verdict.status, 400);
});

Deno.test("a non-JSON body is 415 before anything tries to parse it", async () => {
  const verdict = await checkBody(
    jsonReq("name=alice", "application/x-www-form-urlencoded"),
  );
  assert(verdict instanceof Response);
  assertEquals(verdict.status, 415);
  assertEquals(await verdict.text(), "Unsupported Media Type");
});

Deno.test("unparseable and over-nested bodies are 400, not a 500 from the pipeline", async () => {
  const bad = await checkBody(jsonReq("{not json"));
  assert(bad instanceof Response);
  assertEquals(bad.status, 400);

  const deep = await checkBody(
    jsonReq("[".repeat(MAX_JSON_DEPTH + 1) + "]".repeat(MAX_JSON_DEPTH + 1)),
  );
  assert(deep instanceof Response);
  assertEquals(deep.status, 400);
});

Deno.test("a valid body passes through, rebuilt around the text that was read", async () => {
  const verdict = await checkBody(jsonReq('{"name":"alice"}'));
  assert(verdict instanceof Request, "a good body is not rejected");
  assertEquals(await verdict.text(), '{"name":"alice"}');
  assertEquals(verdict.method, "POST");
  assertEquals(verdict.headers.get("content-type"), "application/json");
});

Deno.test("a bodyless request passes through UNTOUCHED — the upgrade path depends on it", async () => {
  // D-20: a WebSocket upgrade must reach the route as the very Request that
  // arrived, so the gateway must not rebuild one that has no body to check.
  const upgrade = new Request("http://app/api/socket", {
    headers: { upgrade: "websocket" },
  });
  assertEquals(await checkBody(upgrade), upgrade);
});

Deno.test("jsonDepth ignores brackets inside strings and escapes", () => {
  assertEquals(jsonDepth('{"a":[1,2]}'), 2);
  assertEquals(
    jsonDepth('{"a":"[[[["}'),
    1,
    "brackets in a string are not nesting",
  );
  assertEquals(
    jsonDepth('{"a":"\\""}'),
    1,
    "an escaped quote does not end the string",
  );
  assertEquals(jsonDepth(""), 0);
});
