import "#reflect-metadata";
import { assert, assertEquals } from "#assert";
import { ApiProperty } from "#danet/swagger/decorators";
import {
  Endpoint,
  EndpointController,
  endpointModule,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";
import { bootstrapServer } from "./mod.ts";

// The /docs/_* control plane trusts ONLY the in-process client (internal key) or an infra bearer
// with a dev/* grant — no localhost bypass. `server.backend.fetch` dispatches in-process (stamps
// the internal key); `server.handler` is the network dispatcher (strips it), so off-host and
// no-conn network calls are denied.
const offhost = {
  remoteAddr: { transport: "tcp", hostname: "203.0.113.5", port: 1 },
};
// deno-lint-ignore no-explicit-any
const conn = (info: unknown) => info as any;

const jsonInit = (body?: unknown): RequestInit => ({
  method: body === undefined ? "GET" : "POST",
  headers: body === undefined
    ? undefined
    : { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});
/** The in-process client takes a WIRE PATH at the app's own origin (D-7). */
const wire = (path: string) => `/api${path}`;
const jsonReq = (path: string, body?: unknown) =>
  new Request(`http://app${wire(path)}`, jsonInit(body));

class CreateDto {
  @ApiProperty()
  name!: string;
}
class OutDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  name!: string;
}

@EndpointController("things")
class ThingsController {
  @Endpoint({ input: CreateDto, output: OutDto, order: 1 })
  create(body: CreateDto): OutDto {
    return { id: "t-1", name: body?.name ?? "default" };
  }
}
const ThingsModule = endpointModule("Things", [ThingsController]);

Deno.test("/docs/_scenarios - POST saves a file, GET lists it back; bad payloads are 400", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("scen-app", ThingsModule);
  try {
    assertEquals(
      (await (await server.backend.fetch(wire("/docs/_scenarios")))
        .json()).scenarios,
      [],
    );
    const saved = await server.backend.fetch(
      wire("/docs/_scenarios"),
      jsonInit({
        name: "Happy Path",
        module: "things",
        flow: "card",
        steps: [{ id: "create", body: '{"name":"from-scenario"}' }],
      }),
    );
    assertEquals(saved.status, 200);
    // The file lands under fixtures/scenarios/<slug>.json.
    const onDisk = JSON.parse(
      await Deno.readTextFile(`${dir}/scenarios/happy-path.json`),
    );
    assertEquals(onDisk.module, "things");

    const list = (await (await server.backend.fetch(wire("/docs/_scenarios")))
      .json()).scenarios;
    assertEquals(list.length, 1);
    assertEquals(list[0].name, "Happy Path");

    // A scenario without identity fields is rejected.
    assertEquals(
      (await server.backend.fetch(
        wire("/docs/_scenarios"),
        jsonInit({ steps: [] }),
      ))
        .status,
      400,
    );
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/docs/_run - scenario param replays a saved scenario's literal bodies + flow", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("scen-app", ThingsModule);
  try {
    await server.backend.fetch(
      wire("/docs/_scenarios"),
      jsonInit({
        name: "named run",
        module: "things",
        steps: [{
          id: "create",
          // One literal field and one {{ref}} field: the literal must reach the endpoint,
          // the ref must be dropped (the runner's own bind machinery owns those).
          body: '{"name":"from-scenario","other":"{{create.id}}"}',
        }],
      }),
    );
    const res = await server.backend.fetch(
      wire("/docs/_run"),
      jsonInit({ scenario: "Named Run" }),
    );
    assertEquals(res.status, 200);
    const report = await res.json();
    assertEquals(report.ok, true);
    const create = report.passed.find((r: { id: string }) => r.id === "create");
    // The harness rows now carry the response body + ms — the scenario's literal arrived.
    assertEquals(create.body, { id: "t-1", name: "from-scenario" });
    assert(typeof create.ms === "number", "rows carry per-call ms");

    // An unknown scenario is a clear 404.
    assertEquals(
      (await server.backend.fetch(
        wire("/docs/_run"),
        jsonInit({ scenario: "nope" }),
      ))
        .status,
      404,
    );
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/docs/_heal-rules + /docs/_scenarios - open to network callers (zero built-in auth)", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("scen-app", ThingsModule);
  try {
    for (
      const path of ["/docs/_heal-rules", "/docs/_scenarios"]
    ) {
      assertEquals(
        (await server.handler(jsonReq(path), conn(offhost))).status,
        200,
      );
      assertEquals((await server.handler(jsonReq(path))).status, 200);
    }
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/docs/_heal-rules - serves the normalized project rules file", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("scen-app", ThingsModule);
  try {
    // No file yet → the empty rule set.
    assertEquals(
      await (await server.backend.fetch(wire("/docs/_heal-rules")))
        .json(),
      { v: 1, slugs: {} },
    );
    await Deno.writeTextFile(
      `${dir}/heal-rules.json`,
      JSON.stringify({
        v: 1,
        slugs: {
          "not-enabled": [
            // The rune generator's extra fields (todo) must pass through untouched.
            {
              kind: "run-step",
              match: "/enable/i",
              why: "track first",
              todo: true,
            },
          ],
        },
      }),
    );
    const rules = await (await server.backend.fetch(wire("/docs/_heal-rules")))
      .json();
    assertEquals(rules.slugs["not-enabled"][0].match, "/enable/i");
    assertEquals(rules.slugs["not-enabled"][0].todo, true);
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/docs/_run - stream:true emits ndjson result lines then a done summary", async () => {
  const server = await bootstrapServer("scen-app", ThingsModule);
  try {
    const res = await server.backend.fetch(
      wire("/docs/_run"),
      jsonInit({ stream: true, orderBy: "module" }),
    );
    assertEquals(res.status, 200);
    assertEquals(res.headers.get("content-type"), "application/x-ndjson");
    const lines = (await res.text()).trim().split("\n").map((l) =>
      JSON.parse(l)
    );
    const results = lines.filter((l) => l.kind === "result");
    assert(results.length >= 1, "at least one streamed result row");
    assertEquals(results[0].module, "things");
    assertEquals(results[0].id, "create");
    assertEquals(results[0].ok, true);
    assert(results[0].body, "streamed rows carry the response body");
    const done = lines[lines.length - 1];
    assertEquals(done.kind, "done");
    assertEquals(done.ok, true);
    assertEquals(done.passed, 1);
  } finally {
    await server.stop();
  }
});

// ── heal rules feed the runner: retry slugs ───────────────────────────────────

class LeaseDto {
  @ApiProperty()
  done!: boolean;
}

@EndpointController("lease")
class LeaseController {
  static failures = 0;
  @Endpoint({ path: "resolve", output: LeaseDto, order: 1 })
  resolve(): LeaseDto {
    if (LeaseController.failures > 0) {
      LeaseController.failures--;
      throw new Error("lease-held");
    }
    return { done: true };
  }
}
const LeaseModule = endpointModule("Lease", [LeaseController]);

Deno.test("/docs/_run - a slug the heal rules mark retryable is re-attempted, not failed", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  await Deno.writeTextFile(
    `${dir}/heal-rules.json`,
    JSON.stringify({
      v: 1,
      slugs: {
        "lease-held": [{
          kind: "retry",
          why: "another tick holds the lease — it expires in seconds",
        }],
      },
    }),
  );
  LeaseController.failures = 2;
  const server = await bootstrapServer("lease-app", LeaseModule);
  try {
    const res = await server.backend.fetch(wire("/docs/_run"), jsonInit({}));
    const report = await res.json();
    assertEquals(report.ok, true);
    const resolve = report.passed.find((r: { id: string }) =>
      r.id === "resolve"
    );
    // Two lease-held failures absorbed by heal-informed retries within the walk.
    assert(resolve.attempts >= 3, `expected retries: ${resolve.attempts}`);
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});
