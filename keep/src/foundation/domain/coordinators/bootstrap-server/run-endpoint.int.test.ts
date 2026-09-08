import "#reflect-metadata";
import { assert, assertEquals, assertStringIncludes } from "#assert";
import { Bedrock } from "@techgoose-labs/bedrock";
import { ApiProperty } from "#danet/swagger/decorators";
import {
  Endpoint,
  EndpointController,
  endpointModule,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";
import { bootstrapServer } from "./mod.ts";

// The /docs/_* control plane trusts ONLY the in-process client (internal key) or an infra bearer
// with a dev/* grant — there is NO localhost bypass. `server.backend.fetch` dispatches in-process
// (stamps the internal key); `server.handler` is the network dispatcher (strips it), so off-host
// and no-conn network calls are denied.
const offhost = {
  remoteAddr: { transport: "tcp", hostname: "203.0.113.5", port: 1 },
};

// deno-lint-ignore no-explicit-any
const conn = (info: unknown) => info as any;

const RUN_PATH = "/api/docs/_run";
const runInit = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
// The in-process client takes a PATH at the app's own origin (D-7); a Request
// built against a foreign origin falls through to the network, by design.
const runReq = (body?: unknown) =>
  new Request(`http://app${RUN_PATH}`, runInit(body));

// ── fixtures ─────────────────────────────────────────────────────────────────
// A producer module and a consumer module wired only by a `$token` contract input.
class TokenDto {
  @ApiProperty()
  token!: string;
}
class UseDto {
  @ApiProperty()
  token!: string;
}
class UsedDto {
  @ApiProperty()
  usedId!: string;
}

@EndpointController("producer")
class ProducerController {
  @Endpoint({ output: TokenDto, order: 1 })
  mint(): TokenDto {
    return { token: "tok-1" };
  }
}

@EndpointController("consumer")
class ConsumerController {
  @Endpoint({
    input: UseDto,
    output: UsedDto,
    order: 1,
    bind: { token: "$token" },
  })
  use(body: UseDto): UsedDto {
    if (!body?.token) {
      throw new Error("missing token — $input was not satisfied");
    }
    return { usedId: "u-" + body.token };
  }
}

const ProducerModule = endpointModule("Producer", [ProducerController]);
const ConsumerModule = endpointModule("Consumer", [ConsumerController]);

// A forced cycle: two endpoints with explicit mutual dependsOn.
class PingDto {
  @ApiProperty()
  ok!: boolean;
}

@EndpointController("ring")
class CycleController {
  @Endpoint({ path: "ping", output: PingDto, order: 1, dependsOn: "pong" })
  ping(): PingDto {
    return { ok: true };
  }

  @Endpoint({ path: "pong", output: PingDto, order: 2, dependsOn: "ping" })
  pong(): PingDto {
    return { ok: true };
  }
}

const CycleModule = endpointModule("Cycle", [CycleController]);

// ── acceptance ───────────────────────────────────────────────────────────────
Deno.test("POST /docs/_run - in-process walks the composed process, ok:true", async () => {
  const server = await bootstrapServer("run-app", [
    ProducerModule,
    ConsumerModule,
  ]);
  try {
    const res = await server.backend.fetch(RUN_PATH, runInit({}));
    assertEquals(res.status, 200);
    const report = await res.json();
    assertEquals(report.ok, true);
    assertEquals(report.failed, []);
    assertEquals(report.cycles, []);
    // The producer's mint auto-satisfies the consumer's $token (synthetic edge), zero seeds.
    assert(
      report.order.indexOf("mint") < report.order.indexOf("use"),
      `producer must run first: ${report.order}`,
    );
    // Every row carries its module — bare ids collide across composed modules.
    const use = report.passed.find((r: { id: string }) => r.id === "use");
    assertEquals(use.module, "consumer");
  } finally {
    await server.stop();
  }
});

Deno.test("POST /docs/_run - answers a network caller through the composed root", async () => {
  const server = await bootstrapServer("run-app", [
    ProducerModule,
    ConsumerModule,
  ]);
  const app = Bedrock({ backend: server });
  try {
    // With no auth unit composed there is nothing to authenticate against, so
    // the door answers off-host and conn-less callers alike. Under an auth unit
    // the same row resolves `authenticated` outside dev (D-11).
    const offRes = await app(runReq({}), conn(offhost));
    assertEquals(offRes.status, 200);
    assertEquals((await offRes.json()).ok, true);
    const noConn = await app(runReq({}));
    assertEquals(noConn.status, 200);
    await noConn.body?.cancel();
  } finally {
    await app.stop();
  }
});

Deno.test("POST /docs/_run - dispatched OUTSIDE the root, the runner has no client", async () => {
  // The unit's handler called directly was never provisioned with a bag, so
  // there is no client to drive the app with — and the runner says so instead
  // of inventing one (D-13: a unit reaches the app through the bag it was
  // handed, never a self-addressed fetch).
  const server = await bootstrapServer("run-app", ConsumerModule);
  try {
    const res = await server.handler(runReq({}));
    assertEquals(res.status, 503);
    assertStringIncludes((await res.json()).error, "Bedrock");
  } finally {
    await server.stop();
  }
});

Deno.test("POST /docs/_run - seeds in the body satisfy an input with no producer", async () => {
  const server = await bootstrapServer("run-app", ConsumerModule);
  try {
    const res = await server.backend.fetch(
      RUN_PATH,
      runInit({ seeds: { token: "seed-9" } }),
    );
    assertEquals(res.status, 200);
    const report = await res.json();
    assertEquals(report.ok, true);
    assertEquals(report.failed, []);
  } finally {
    await server.stop();
  }
});

Deno.test("POST /docs/_run - a forced cycle returns ok:false with the cycle named", async () => {
  const server = await bootstrapServer("run-app", CycleModule);
  try {
    const res = await server.backend.fetch(RUN_PATH, runInit({}));
    assertEquals(res.status, 200);
    const report = await res.json();
    assertEquals(report.ok, false);
    assert(report.cycles.length > 0, "the cycle must be reported");
    assertEquals([...report.cycles[0]].sort(), ["ping", "pong"]);
  } finally {
    await server.stop();
  }
});

Deno.test("POST /docs/_run - dryRun reports unresolved inputs without executing", async () => {
  const server = await bootstrapServer("run-app", ConsumerModule);
  try {
    const res = await server.backend.fetch(RUN_PATH, runInit({ dryRun: true }));
    assertEquals(res.status, 200);
    const report = await res.json();
    // $token has no producer and no seed here ⇒ flagged; nothing ran.
    assertEquals(report.unresolvedInputs, ["$token"]);
    assertEquals(report.cycles, []);
    assertEquals(report.passed, undefined);
  } finally {
    await server.stop();
  }
});

Deno.test("POST /docs/_heal - open door, 503 when no healer is configured", async () => {
  const savedUrl = Deno.env.get("PRIVATE_CLAUDE_URL");
  Deno.env.delete("PRIVATE_CLAUDE_URL");
  const server = await bootstrapServer("run-app", ConsumerModule);
  try {
    const HEAL_PATH = "/api/docs/_heal";
    const healInit = (): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ endpoint: { id: "use" } }),
    });
    const req = () => new Request(`http://app${HEAL_PATH}`, healInit());
    // The door is open (zero built-in auth); unconfigured → explicit 503 naming
    // the env var, for network and in-process callers alike.
    assertEquals((await server.handler(req(), conn(offhost))).status, 503);
    const res = await server.backend.fetch(HEAL_PATH, healInit());
    assertEquals(res.status, 503);
    const body = await res.json();
    assertEquals(body.error.includes("PRIVATE_CLAUDE_URL"), true);
  } finally {
    if (savedUrl !== undefined) Deno.env.set("PRIVATE_CLAUDE_URL", savedUrl);
    await server.stop();
  }
});
