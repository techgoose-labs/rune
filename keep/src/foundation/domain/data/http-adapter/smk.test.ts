import "#reflect-metadata";
import { assertEquals, assertExists } from "#assert";
import { Module } from "#danet/core";
import { DanetHttpAdapter, HttpAdapter } from "./mod.ts";

@Module({})
class EmptyModule {}

Deno.test("DanetHttpAdapter - can be instantiated", () => {
  const adapter = new DanetHttpAdapter(3000);
  assertExists(adapter);
  assertExists(adapter.app);
});

Deno.test("DanetHttpAdapter - extends HttpAdapter", () => {
  const adapter = new DanetHttpAdapter(4000);
  assertExists(adapter instanceof HttpAdapter);
});

Deno.test("DanetHttpAdapter - defaultPort is set", () => {
  const adapter = new DanetHttpAdapter(5000);
  assertExists(adapter.defaultPort);
});

Deno.test("DanetHttpAdapter - binds nothing: the socket is the composed app's", async () => {
  // The port walk is gone with the socket. One listener serves the whole app,
  // bedrock's lifecycle binds it, and `PORT` is fail-loud in the env registry
  // rather than silently walking to a port nobody asked for. `rune dev` keeps
  // its own probing, in the CLI, where retrying a dev loop belongs.
  const adapter = new DanetHttpAdapter(38_500);
  const err = await adapter.listen(EmptyModule).then(
    () => null,
    (e: Error) => e,
  );
  assertExists(err);
  assertEquals(err!.message.includes("Bedrock({ backend: api })"), true);
});

Deno.test("DanetHttpAdapter - mountedHandler matches under a namespace, request untouched", async () => {
  const adapter = new DanetHttpAdapter();
  await adapter.init(EmptyModule);
  let seen: Request | undefined;
  adapter.registerRoute("get", "/ping", (c: unknown) => {
    seen = (c as { req: { raw: Request } }).req.raw;
    return new Response("pong");
  });

  const mounted = adapter.mountedHandler("/api");
  const original = new Request("http://app/api/ping");
  const res = await mounted(original);
  assertEquals(await res.text(), "pong");
  // D-20: the very Request that arrived reaches the route — not a rewrite —
  // which is what makes an upgrade through the mount possible at all.
  assertEquals(seen, original);
  assertEquals(seen!.url, "http://app/api/ping");
  await adapter.stop();
});
