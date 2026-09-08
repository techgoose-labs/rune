import "#reflect-metadata";
import { assertEquals, assertStringIncludes } from "#assert";
import { applyFieldSources, SwaggerBuilder } from "./mod.ts";
import { Server } from "@foundation/domain/business/server/mod.ts";
import {
  Endpoint,
  EndpointController,
  endpointModule,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";
import { endpointsFromDoc } from "@foundation/domain/business/endpoint-spec/mod.ts";
import { ApiProperty } from "#danet/swagger/decorators";
import { IsString } from "class-validator";
import type { OpenApiDocument } from "@types";

class TestModule {}
Reflect.defineMetadata("module", {}, TestModule);

Deno.test("SwaggerBuilder - builds swagger docs and index page from server", async () => {
  const server = Server.create();
  server.registerModule(TestModule);

  const builder = new SwaggerBuilder();
  const { swaggerDocs, docsIndexHtml } = await builder.build(server);

  assertEquals(swaggerDocs.length, 1);
  assertEquals(swaggerDocs[0].path, "/test");
  assertEquals(swaggerDocs[0].doc.info.title, "Test");
  assertEquals(swaggerDocs[0].doc.info.version, "1.0");
  assertStringIncludes(docsIndexHtml, "<html");
  assertStringIncludes(docsIndexHtml, "Test");
  // Mount-relative so the index works at "/docs" standalone and "/api/docs" under Fresh.
  assertStringIncludes(docsIndexHtml, 'href="docs/test"');
});

Deno.test("SwaggerBuilder - respects filters", async () => {
  class ModuleA {}
  Reflect.defineMetadata("module", {}, ModuleA);
  class ModuleB {}
  Reflect.defineMetadata("module", {}, ModuleB);

  const server = Server.create();
  server.registerModule(ModuleA);
  server.registerModule(ModuleB);

  const builder = new SwaggerBuilder("ModuleB");
  const { swaggerDocs } = await builder.build(server);

  assertEquals(swaggerDocs.length, 1);
  assertEquals(swaggerDocs[0].doc.info.title, "ModuleA");
});

Deno.test("SwaggerBuilder - concurrent multi-module build leaves console.log intact", async () => {
  // Regression: build() inits one throwaway facade per module CONCURRENTLY, and each init
  // silences console.log. With per-call save/restore the second facade captured the first's
  // no-op as its "original" and restored that — console.log stayed dead for the host app.
  class LogModuleA {}
  Reflect.defineMetadata("module", {}, LogModuleA);
  class LogModuleB {}
  Reflect.defineMetadata("module", {}, LogModuleB);

  const server = Server.create();
  server.registerModule(LogModuleA);
  server.registerModule(LogModuleB);

  const original = console.log;
  const { swaggerDocs } = await new SwaggerBuilder().build(server);

  assertEquals(swaggerDocs.length, 2);
  assertEquals(
    console.log,
    original,
    "console.log must be restored to the host app's original after the concurrent facade inits",
  );
});

Deno.test("applyFieldSources - moves sourced fields from body to typed params", () => {
  const doc: OpenApiDocument = {
    paths: {
      "/http/proxy/{target}/{rest}": {
        post: {
          operationId: "proxy",
          // danet already emitted the path params from the route segments.
          parameters: [
            { name: "target", in: "path", required: true },
            { name: "rest", in: "path", required: true },
          ],
          requestBody: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ProxyReqDto" },
              },
            },
          },
          "x-keep-process": {
            dependsOn: [],
            bind: {},
            method: "post",
            path: "proxy/:target/:rest{.+}",
            sources: {
              target: "path",
              rest: "path*",
              q: "query",
              auth: "header",
            },
          },
        },
      },
    },
    components: {
      schemas: {
        ProxyReqDto: {
          type: "object",
          properties: {
            target: { type: "string" },
            rest: { type: "string" },
            q: { type: "string" },
            auth: { type: "string" },
            payload: { type: "string" },
          },
          required: ["target", "rest", "q", "auth", "payload"],
        },
      },
    },
  };
  applyFieldSources(doc);
  const op = doc.paths!["/http/proxy/{target}/{rest}"].post;
  // Path params untouched (deduped, not doubled); query + header added.
  assertEquals(op.parameters!.map((p) => `${p.name}:${p.in}`), [
    "target:path",
    "rest:path",
    "q:query",
    "auth:header",
  ]);
  // The body keeps ONLY the body-sourced field, inline (the shared component is untouched).
  assertEquals(op.requestBody!.content!["application/json"].schema, {
    type: "object",
    properties: { payload: { type: "string" } },
    required: ["payload"],
  });
  const comp = doc.components!.schemas!.ProxyReqDto as { properties: object };
  assertEquals(
    Object.keys(comp.properties).length,
    5,
    "shared component is left intact",
  );
});

Deno.test("SwaggerBuilder - source-bound endpoint: catch-all routes, params, stripped body (e2e)", async () => {
  class ProxyReqDto {
    @ApiProperty()
    @IsString()
    target!: string;
    @ApiProperty()
    @IsString()
    rest!: string;
    @ApiProperty()
    @IsString()
    q!: string;
    @ApiProperty()
    @IsString()
    payload!: string;
  }
  class ProxyResDto {
    @ApiProperty()
    @IsString()
    status!: string;
  }
  @EndpointController("http")
  class HttpController {
    // The catch-all `:rest{.+}` would throw in @danet/swagger's path-to-regexp; the doc builder
    // rewrites it to the paren form for doc-gen only, so this whole build must succeed.
    @Endpoint({
      path: "proxy/:target/:rest{.+}",
      input: ProxyReqDto,
      output: ProxyResDto,
      order: 1,
      sources: { target: "path", rest: "path*", q: "query" },
    })
    proxy(_b: ProxyReqDto): Promise<ProxyResDto> {
      return Promise.resolve(new ProxyResDto());
    }
  }
  const server = Server.create();
  server.registerModule(endpointModule("Gateway", [HttpController]));
  const { swaggerDocs } = await new SwaggerBuilder().build(server);
  const doc = swaggerDocs[0].doc;
  const [ep] = endpointsFromDoc(doc as unknown as OpenApiDocument);
  assertEquals(ep.path, "/http/proxy/{target}/{rest}");
  assertEquals(ep.params.map((p) => `${p.name}:${p.in}`), [
    "target:path",
    "rest:path",
    "q:query",
  ]);
  // Only the body-sourced field survives in the request body.
  assertEquals(ep.inputFields, ["payload"]);
});

Deno.test("required honors class-validator @IsOptional", async () => {
  const { IsInt, IsOptional, IsString } = await import("class-validator");
  class OptionalProbeDto {
    @IsString()
    name!: string;
    @IsOptional()
    @IsInt()
    limit?: number;
  }
  // keep the class referenced so the decorators actually run
  void OptionalProbeDto;

  const { honorOptionalProps, optionalPropsByClassName } = await import(
    "./mod.ts"
  );
  const optionals = optionalPropsByClassName();
  assertEquals(optionals.get("OptionalProbeDto")?.has("limit"), true);

  const doc = {
    components: {
      schemas: {
        OptionalProbeDto: { required: ["name", "limit"] },
        Untouched: { required: ["x"] },
      },
    },
  };
  honorOptionalProps(doc, optionals);
  assertEquals(doc.components.schemas.OptionalProbeDto.required, ["name"]);
  assertEquals(doc.components.schemas.Untouched.required, ["x"]);
});
