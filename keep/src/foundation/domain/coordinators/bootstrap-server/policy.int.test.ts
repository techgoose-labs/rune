// Where an endpoint's policy comes from (D-3, D-11).
//
// The chain this pins, end to end: a spec's `[REQ:open]` → codegen's
// `access: "open"` on `@Endpoint` → `x-bedrock-auth` on the operation's
// OpenAPI → a row in the `Policy` table keep's unit hands bedrock → bedrock
// resolving it. keep never reads the table it produces, and bedrock never
// parses OpenAPI; the extension is the whole of the seam between them.
//
// This is what retires the hand-applied guard decorator: openness used to be a
// `@Open()` re-added to generated controllers after every regeneration, and a
// missed one silently exposed a route (or silently closed one).

import "#reflect-metadata";
import { assert, assertEquals } from "#assert";
import { ApiProperty } from "#danet/swagger/decorators";
import {
  Endpoint,
  EndpointController,
  endpointModule,
} from "../../business/endpoint-decorator/mod.ts";
import { bootstrapServer, policyFromDocs } from "./mod.ts";
import { Bedrock, grantsSatisfied } from "@mrg-keystone/bedrock";
import type { Access } from "@mrg-keystone/bedrock";

class OutDto {
  @ApiProperty()
  ok!: boolean;
}

@EndpointController("things")
class ThingsController {
  // `[REQ:open]` in the spec → this, in the generated controller.
  @Endpoint({
    path: "public",
    method: "get",
    output: OutDto,
    order: 1,
    access: "open",
  })
  publicRead(): OutDto {
    return { ok: true };
  }

  // Unmarked: the slot default. NOT the same as an explicit "authenticated" —
  // the extension is absent entirely, so bedrock applies the slot's rule.
  @Endpoint({ path: "private", method: "get", output: OutDto, order: 2 })
  privateRead(): OutDto {
    return { ok: true };
  }

  // A grants row, for the shape the marker will grow into.
  @Endpoint({
    path: "admin",
    method: "get",
    output: OutDto,
    order: 3,
    access: { grants: ["admin"] },
  })
  adminRead(): OutDto {
    return { ok: true };
  }
}

const ThingsModule = endpointModule("Things", [ThingsController]);

Deno.test("the openness marker travels: @Endpoint access → x-bedrock-auth → a policy row", async () => {
  const api = await bootstrapServer("policy-app", ThingsModule);
  try {
    // 1. It is on the OpenAPI, under its own extension.
    const doc = api.docs[0].doc as unknown as {
      paths: Record<
        string,
        Record<string, { "x-bedrock-auth"?: { access: Access } }>
      >;
    };
    const marked = Object.entries(doc.paths).find(([p]) =>
      p.endsWith("/public")
    );
    assert(
      marked,
      `no /public operation in ${Object.keys(doc.paths).join(", ")}`,
    );
    assertEquals(marked![1].get?.["x-bedrock-auth"], { access: "open" });

    const unmarked = Object.entries(doc.paths).find(([p]) =>
      p.endsWith("/private")
    );
    assertEquals(
      unmarked![1].get?.["x-bedrock-auth"],
      undefined,
      "silence is the slot default, not an explicit `authenticated`",
    );

    // 2. keep derived a table from it — and derived NO row for the unmarked one.
    const rows = policyFromDocs(api.docs);
    const publicRow = rows.find((r) => r.path.endsWith("/public"));
    assertEquals(publicRow?.access, "open");
    assertEquals(publicRow?.method, "GET");
    assertEquals(rows.some((r) => r.path.endsWith("/private")), false);
    assertEquals(
      rows.find((r) => r.path.endsWith("/admin"))?.access,
      { grants: ["admin"] },
    );

    // 3. And the unit carries that table to the root.
    assert(
      api.policy!.some((r) =>
        r.path.endsWith("/public") && r.access === "open"
      ),
    );
  } finally {
    await api.stop();
  }
});

Deno.test("bedrock resolves the derived table, qualified by keep's namespace", async () => {
  const api = await bootstrapServer("policy-app", ThingsModule);
  const app = Bedrock({ backend: api });
  try {
    // The bag's `policy` is the MERGED table, resolved at wire paths — so this
    // is bedrock answering, from rows keep produced from a spec marker.
    const res = await app(new Request("http://app/api/things/public"));
    assertEquals(res.status, 200);

    // With no auth unit composed nothing is denied — the rows still exist, and
    // the composed shape that enforces them is proved by the guard vectors.
    const priv = await app(new Request("http://app/api/things/private"));
    assertEquals(priv.status, 200);
  } finally {
    await app.stop();
  }
});

Deno.test("grantsSatisfied is what a grants row means", () => {
  assertEquals(grantsSatisfied(["admin"], ["admin", "billing"]), true);
  assertEquals(grantsSatisfied(["admin"], ["billing"]), false);
});
