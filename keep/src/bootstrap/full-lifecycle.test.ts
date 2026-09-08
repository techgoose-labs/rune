import "#reflect-metadata";
import { assertEquals, assertExists, assertStringIncludes } from "#assert";
import {
  bootstrapServer,
  DanetDocumentBuilder,
  DanetHttpAdapter,
  HttpAdapter,
  InjectClass,
  InjectFactory,
  InjectValue,
  log,
  requestId,
  Server,
  setupWithSwagger,
  SwaggerDescription,
} from "./mod.ts";
import { Body, Controller, Get, Module, Post, Req } from "#danet/core";

function captureConsole() {
  const lines: { level: string; args: unknown[] }[] = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
  };
  // bedrock's logger writes one JSON line per event with console.log.
  console.log = (...a: unknown[]) => void lines.push({ level: "log", args: a });
  console.info = (...a: unknown[]) =>
    void lines.push({ level: "info", args: a });
  console.warn = (...a: unknown[]) =>
    void lines.push({ level: "warn", args: a });
  console.error = (...a: unknown[]) =>
    void lines.push({ level: "error", args: a });
  console.debug = (...a: unknown[]) =>
    void lines.push({ level: "debug", args: a });
  return {
    messages: () => lines.map((l) => String(l.args[0])),
    restore: () => Object.assign(console, orig),
  };
}

// -- Verify all public exports exist --

Deno.test("e2e: all public exports are defined", () => {
  assertExists(bootstrapServer);
  assertExists(DanetDocumentBuilder);
  assertExists(DanetHttpAdapter);
  assertExists(HttpAdapter);
  assertExists(Server);
  assertExists(setupWithSwagger);
  assertExists(SwaggerDescription);
  assertExists(InjectValue);
  assertExists(InjectFactory);
  assertExists(InjectClass);
});

// -- Full lifecycle: bootstrap, serve, swagger, teardown --

@SwaggerDescription("Health API - system health checks")
@Controller("health")
class HealthController {
  @Get()
  check() {
    return { status: "ok" };
  }

  @Post("echo")
  echo(@Body() body: { msg: string }) {
    return { echoed: body.msg };
  }

  @Get("log")
  emitLog(@Req() req: Request) {
    log.info("custom event", { detail: 42 });
    return { logged: true, requestId: requestId(req) };
  }
}

@Module({
  controllers: [HealthController],
})
class TestAppModule {}

// Base port for the over-the-wire lifecycle tests. Kept off the common 9100/3000 dev ports so a
// stray local `deno serve` can't squat it and make these fetches hit the wrong server.
let port = 9410;

Deno.test("e2e: bootstrap server with swagger, hit endpoints, teardown", async () => {
  const p = port++;
  const server = await bootstrapServer("e2e-app", TestAppModule, { port: p });
  await server.listen();

  // Health endpoint works
  const healthRes = await fetch(`http://localhost:${p}/api/health`);
  const healthBody = await healthRes.json();
  assertEquals(healthRes.status, 200);
  assertEquals(healthBody.status, "ok");

  // Swagger index page is served
  const docsRes = await fetch(`http://localhost:${p}/api/docs`);
  const docsHtml = await docsRes.text();
  assertEquals(docsRes.status, 200);
  assertStringIncludes(docsHtml, "<html");

  await server.stop();
});

Deno.test("e2e: bootstrap server without swagger", async () => {
  const p = port++;
  const server = await bootstrapServer("e2e-app", TestAppModule, {
    port: p,
    swagger: false,
  });
  await server.listen();

  const healthRes = await fetch(`http://localhost:${p}/api/health`);
  const healthBody = await healthRes.json();
  assertEquals(healthRes.status, 200);
  assertEquals(healthBody.status, "ok");

  const docsRes = await fetch(`http://localhost:${p}/api/docs`);
  await docsRes.text();
  assertEquals(docsRes.status, 404);

  await server.stop();
});

Deno.test("e2e: Server + DanetDocumentBuilder + setupWithSwagger integration", async () => {
  const server = Server.create();
  server.registerModule(TestAppModule);

  assertEquals(server.modules.length, 1);
  assertEquals(server.moduleNames, ["TestAppModule"]);

  // Build swagger docs through the coordinator
  const adapter = await setupWithSwagger(server);
  assertExists(adapter);

  const routes = adapter.app.router.routes;
  const getPaths = routes
    .filter((r: { method: string }) => r.method === "GET")
    .map((r: { path: string }) => r.path);

  assertEquals(getPaths.includes("/docs"), true);
});

Deno.test("e2e: backend client hits the real pipeline in-process, without listen()", async () => {
  // Never call listen() — no port is bound. The backend dispatches via Hono's fetch.
  const server = await bootstrapServer("e2e-app", TestAppModule, {
    swagger: false,
  });

  const health = await server.backend.fetch("/api/health");
  assertEquals(health.status, 200);
  assertEquals((await health.json()).status, "ok");

  // POST body is routed through @Body() and round-tripped back.
  const echo = await server.backend.fetch("/api/health/echo", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg: "hi" }),
  });
  assertEquals(echo.status, 200);
  assertEquals((await echo.json()).echoed, "hi");

  // Unknown routes still flow through the real 404 handling.
  const missing = await server.backend.fetch("/api/nope");
  assertEquals(missing.status, 404);

  await server.stop();
});

Deno.test("e2e: backend.fetch is a drop-in for global fetch (raw Response)", async () => {
  const server = await bootstrapServer("e2e-app", TestAppModule, {
    swagger: false,
  });

  // Same call shape as global fetch — relative path, RequestInit, returns a Response.
  const res = await server.backend.fetch("/api/health");
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { status: "ok" });

  // Accepts a Request object too, exactly like global fetch.
  const viaRequest = await server.backend.fetch(
    new Request("http://localhost/api/health/echo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg: "yo" }),
    }),
  );
  assertEquals(await viaRequest.json(), { echoed: "yo" });

  await server.stop();
});

Deno.test("e2e: bootstrapServer does not block — code after it (and after listen) runs", async () => {
  const p = port++;
  let reached = false;
  const server = await bootstrapServer("e2e-app", TestAppModule, {
    port: p,
    swagger: false,
  });
  reached = true; // bootstrap returned (init only, no port bound)
  assertEquals(reached, true);

  await server.listen();
  reached = false;
  reached = true; // proves await listen() resolved and did not block until shutdown
  assertEquals(reached, true);

  await server.stop();
});

Deno.test("e2e: backend and the real network agree on the same response", async () => {
  const p = port++;
  const server = await bootstrapServer("e2e-app", TestAppModule, {
    port: p,
    swagger: false,
  });
  await server.listen();

  const overWire = await (await fetch(`http://localhost:${p}/api/health`))
    .json();
  const inProcess = await (await server.backend.fetch("/api/health")).json();
  assertEquals(inProcess, overWire);

  await server.stop();
});

Deno.test("e2e: the boundary's one id joins the log lines and the envelope", async () => {
  // The correlation id is bedrock's now, minted ONCE at the boundary, and it
  // is what a controller reads back off the envelope. keep's own ingress/egress
  // middleware is gone with the duplication it caused: a dispatch is captured
  // once, at the root, on every channel.
  const cap = captureConsole();
  let seen: { requestId?: string } | undefined;
  let logged: string[] = [];
  try {
    const server = await bootstrapServer("log-app", TestAppModule, {
      swagger: false,
    });
    const res = await server.backend.fetch("/api/health/log");
    seen = await res.json();
    await server.stop();
    logged = cap.messages();
  } finally {
    cap.restore();
  }

  assertExists(seen?.requestId);
  // Every structured line the dispatch emitted carries that same id.
  const withId = logged.filter((m) => m.includes(seen!.requestId!));
  assertEquals(
    withId.some((m) => m.includes("custom event")),
    true,
    `the handler's own log line joins on the boundary's id: ${
      logged.join(" | ")
    }`,
  );
});

Deno.test("e2e: an inbound x-bedrock-request-id cannot forge the correlation id", async () => {
  // The envelope is stripped at the root before anything reads it, so a caller
  // cannot choose the id its lines are filed under. This replaces 6.x's
  // sanitize-the-inbound-x-request-id rule: there is nothing to sanitize when
  // the header never survives the boundary.
  const server = await bootstrapServer("log-app", TestAppModule, {
    swagger: false,
  });
  const res = await server.backend.fetch("/api/health/log", {
    headers: { "x-bedrock-request-id": "forged" },
  });
  const body = await res.json();
  await server.stop();

  assertExists(body.requestId);
  assertEquals(body.requestId === "forged", false);
});

Deno.test("e2e: InjectValue, InjectFactory, InjectClass constructors", () => {
  const val = new InjectValue("TOKEN_A", 42);
  assertEquals(val.provide, "TOKEN_A");
  assertEquals(val.useValue, 42);

  const factory = new InjectFactory("TOKEN_B", () => "built");
  assertEquals(factory.provide, "TOKEN_B");
  assertEquals((factory.useFactory as () => string)(), "built");

  const cls = new InjectClass("TOKEN_C", HealthController);
  assertEquals(cls.provide, "TOKEN_C");
  assertEquals(cls.useClass, HealthController);
});
