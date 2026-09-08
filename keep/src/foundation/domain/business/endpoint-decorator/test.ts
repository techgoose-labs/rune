import "#reflect-metadata";
import { assert, assertEquals, assertExists } from "#assert";
import { ApiProperty } from "#danet/swagger/decorators";
import {
  Endpoint,
  EndpointController,
  endpointModule,
  getProcessMetadata,
} from "./mod.ts";
import { Server } from "@foundation/domain/business/server/mod.ts";
import { SwaggerBuilder } from "@foundation/domain/business/swagger-builder/mod.ts";
import { bootstrapServer } from "@foundation/domain/coordinators/bootstrap-server/mod.ts";

class CreateUserDto {
  @ApiProperty()
  name!: string;
}
class UserRefDto {
  @ApiProperty()
  id!: string;
}
class UserDto {
  @ApiProperty()
  id!: string;
  @ApiProperty()
  name!: string;
}

@EndpointController("users", { description: "Users API" })
class UsersController {
  @Endpoint({ method: "post", input: CreateUserDto, output: UserDto, order: 1 })
  create(body: CreateUserDto): UserDto {
    return { id: "u_1", name: body.name };
  }

  @Endpoint({
    method: "post",
    path: "fetch",
    input: UserRefDto,
    output: UserDto,
    order: 2,
    dependsOn: "create",
    bind: { id: "create.id" },
  })
  fetch(body: UserRefDto): UserDto {
    return { id: body.id, name: "fetched" };
  }
}

const UsersModule = endpointModule("Users", [UsersController]);

Deno.test("Endpoint - route is served and runs the handler (in-process)", async () => {
  const server = await bootstrapServer("dec-app", UsersModule, {
    swagger: false,
  });
  try {
    const res = await server.backend.fetch("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada" }),
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id: "u_1", name: "Ada" });
  } finally {
    await server.stop();
  }
});

Deno.test("Endpoint - chained route receives a body and returns it", async () => {
  const server = await bootstrapServer("dec-app", UsersModule, {
    swagger: false,
  });
  try {
    const res = await server.backend.fetch("/api/users/fetch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "u_1" }),
    });
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { id: "u_1", name: "fetched" });
  } finally {
    await server.stop();
  }
});

Deno.test("Endpoint - Swagger doc carries paths and DTO schemas", async () => {
  const server = Server.create();
  server.registerModule(UsersModule);
  const { swaggerDocs } = await new SwaggerBuilder().build(server);

  assertEquals(swaggerDocs.length, 1);
  const doc = swaggerDocs[0].doc;
  assertEquals(swaggerDocs[0].path, "/users");

  // Paths + operationId (= method name) present.
  assertExists(doc.paths["/users"]?.post);
  assertExists(doc.paths["/users/fetch"]?.post);
  assertEquals(doc.paths["/users"]!.post!.operationId, "create");

  // Request + response schemas wired through BodyType/ReturnedType.
  const createOp = doc.paths["/users"]!.post!;
  const ref = (createOp.requestBody as {
    content: Record<string, { schema: { $ref: string } }>;
  })
    .content["application/json"].schema.$ref;
  assertEquals(ref, "#/components/schemas/CreateUserDto");

  const schemas = doc.components!.schemas!;
  assertExists(schemas.CreateUserDto);
  assertExists(schemas.UserDto);
  assertExists(schemas.UserRefDto);
  // DTO field made it into the schema.
  assertExists(
    (schemas.UserDto as { properties: Record<string, unknown> }).properties.id,
  );

  // Process metadata travels with the spec as the x-keep-process vendor extension.
  const fetchOp = doc.paths["/users/fetch"]!.post! as unknown as Record<
    string,
    unknown
  >;
  assertEquals(fetchOp["x-keep-process"], {
    order: 2,
    dependsOn: ["create"],
    bind: { id: "create.id" },
    flows: [],
    optional: false,
    stub: false,
    method: "post",
    path: "fetch",
  });
});

Deno.test("Endpoint - process metadata is stamped for the emulator/runner", () => {
  const create = getProcessMetadata(UsersController.prototype, "create");
  const fetch = getProcessMetadata(UsersController.prototype, "fetch");
  assertExists(create);
  assertExists(fetch);
  assertEquals(create!.order, 1);
  assertEquals(create!.dependsOn, []);
  assertEquals(fetch!.order, 2);
  assertEquals(fetch!.dependsOn, ["create"]);
  assertEquals(fetch!.bind, { id: "create.id" });
  assert(fetch!.method === "post");
});
