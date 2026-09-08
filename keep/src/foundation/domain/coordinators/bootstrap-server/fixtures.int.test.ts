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
// with a dev/* grant — there is NO localhost bypass. `server.backend.fetch` dispatches in-process
// (stamps the internal key); `server.handler` is the network dispatcher (strips it), so off-host
// and no-conn network calls are denied. connInfo is now irrelevant to the gate.
const offhost = {
  remoteAddr: { transport: "tcp", hostname: "203.0.113.5", port: 1 },
};

// deno-lint-ignore no-explicit-any
const conn = (info: unknown) => info as any;

const FIXTURES_PATH = "/api/docs/_fixtures";
const getReq = () => new Request(`http://app${FIXTURES_PATH}`);
const postInit = (body?: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

class CreateDto {
  @ApiProperty()
  name!: string;
}
class OutDto {
  @ApiProperty()
  id!: string;
}

@EndpointController("orders")
class OrdersController {
  @Endpoint({ input: CreateDto, output: OutDto, order: 1 })
  create(_body: CreateDto): OutDto {
    return { id: "o-1" };
  }
}
const OrdersModule = endpointModule("Orders", [OrdersController]);

Deno.test("/docs/_fixtures - POST writes cake.json, GET reads it back (in-process)", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("orders-app", OrdersModule);
  try {
    // Empty before anything is written.
    const before = await (await server.backend.fetch(FIXTURES_PATH))
      .json();
    assertEquals(before, { v: 1, variables: {}, modules: {} });

    // POST a page's slice — its setup plus the persisted variables.
    const postRes = await server.backend.fetch(
      FIXTURES_PATH,
      postInit({
        module: "orders",
        setup: [{ id: "create", body: '{"name":"acme"}' }],
        variables: { tenantId: "t-7" },
      }),
    );
    assertEquals(postRes.status, 200);
    const merged = await postRes.json();
    assertEquals(merged.variables, { tenantId: "t-7" });
    assertEquals(merged.modules.orders.setup, [
      { id: "create", body: '{"name":"acme"}' },
    ]);
    assert(typeof merged.savedAt === "number", "savedAt is stamped on write");

    // The file is really on disk, and GET returns the same artifact.
    const onDisk = JSON.parse(await Deno.readTextFile(`${dir}/cake.json`));
    assertEquals(onDisk.modules.orders.setup[0].id, "create");
    const got = await (await server.backend.fetch(FIXTURES_PATH)).json();
    assertEquals(got.variables, { tenantId: "t-7" });

    // A second module's POST merges in without clobbering orders' slice.
    await server.backend.fetch(
      FIXTURES_PATH,
      postInit({
        module: "members",
        setup: [{ id: "enroll" }],
        variables: { tenantId: "t-7" },
      }),
    );
    const both = await (await server.backend.fetch(FIXTURES_PATH)).json();
    assertEquals(both.modules.orders.setup[0].id, "create");
    assertEquals(both.modules.members.setup[0].id, "enroll");
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("/docs/_fixtures - open to network callers (zero built-in auth)", async () => {
  const dir = await Deno.makeTempDir();
  Deno.env.set("KEEP_FIXTURES_DIR", dir);
  const server = await bootstrapServer("orders-app", OrdersModule);
  try {
    // keep ships no built-in gate: off-host and conn-less callers are served.
    assertEquals((await server.handler(getReq(), conn(offhost))).status, 200);
    assertEquals((await server.handler(getReq())).status, 200);
  } finally {
    await server.stop();
    Deno.env.delete("KEEP_FIXTURES_DIR");
    await Deno.remove(dir, { recursive: true });
  }
});
