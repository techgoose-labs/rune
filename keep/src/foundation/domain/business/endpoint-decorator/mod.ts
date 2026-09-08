/**
 * `@Endpoint` / `@EndpointController` — the one place keep learns about an endpoint.
 *
 * A rune-generated coordinator becomes a live, Swagger-documented HTTP route by writing a small
 * controller class whose handler is decorated with `@Endpoint`. The decorator composes danet's
 * route + body decorators (so the route is *served* and danet injects the parsed body) with
 * `@danet/swagger`'s `BodyType`/`ReturnedType` (so the request/response DTO **schemas** appear in
 * the generated OpenAPI doc), and stamps **process metadata** (`order` / `dependsOn` / `bind`)
 * that the per-module emulator UI and the headless runner read to order and chain the endpoints.
 *
 * It is a thin composition of decorators used with `@` syntax — so `emitDecoratorMetadata`
 * emits `design:paramtypes` for the handler naturally, and danet's body validation/injection work
 * exactly as for a hand-written controller.
 */

import "#reflect-metadata";
import {
  Body,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  Module,
  OnWebSocketMessage,
  Patch,
  Post,
  Put,
  WebSocketController,
} from "#danet/core";
import { BodyType, Description, ReturnedType } from "#danet/swagger/decorators";
import { SwaggerDescription } from "@foundation/domain/business/swagger-description/mod.ts";
import {
  assembleSourcedInput,
  coerceToType,
  type FieldSource,
} from "@foundation/domain/business/input-binder/mod.ts";
import { assert } from "../../../../assert/mod.ts";
import type { Type } from "@types";

/** Where the per-endpoint process metadata is stored, keyed on (controller prototype, method). */
export const PROCESS_METADATA_KEY = "keep:process";

export type EndpointMethod = "get" | "post" | "put" | "patch" | "delete";

export interface EndpointOptions {
  /** HTTP verb. Defaults to "post" (an endpoint usually takes an input DTO ⇒ body). */
  method?: EndpointMethod;
  /** Sub-path under the controller surface, e.g. "" or ":id". Defaults to "". */
  path?: string;
  /** Request DTO class — drives danet body injection + the Swagger requestBody schema. */
  input?: Type;
  /** Response DTO class — drives the Swagger 200 response schema (`@ReturnedType`). */
  output?: Type;
  /** Position in the process order shown by the emulator (ascending). */
  order?: number;
  /**
   * Endpoint id(s) — handler method names — that must succeed before this one is unlocked. An
   * inner array is an OR-group (any member unlocks): `dependsOn: ["a", ["b", "c"]]` means
   * `a AND (b OR c)`, mirroring `bind` alternatives.
   */
  dependsOn?: string | (string | string[])[];
  /**
   * Output→input wiring: `{ thisInputField: "otherEndpointId.outputField" }`. The emulator and
   * runner pre-fill this endpoint's request body from captured responses of the named endpoints.
   * A `"$name"` value instead declares an **external input** — something no endpoint in this
   * module produces (an id minted by another module, a tenant key). The emulator resolves it
   * from its shared variable scope (set once, visible on every docs page) and lists it under
   * "module inputs"; the headless runner resolves it from `overrides.seeds[name]`.
   * An **array** value declares alternatives — first resolvable wins (the join after a branch:
   * `{ paymentId: ["payCard.paymentId", "payCash.paymentId"] }`).
   */
  bind?: Record<string, string | string[]>;
  /**
   * Named flow(s) this endpoint belongs to — a branch through the module's process (e.g.
   * "card-payment"). Untagged endpoints are part of every flow. The emulator shows a flow
   * selector and walks only the active flow; within a flow, dependencies on endpoints outside
   * it don't gate (so an after-the-branch step can depend on every alternative and unlock when
   * the chosen one passes).
   */
  flows?: string | string[];
  /**
   * A step run-all and the headless runner attempt but don't require: its failure doesn't stop
   * the walk or fail the report. For steps that need state the chain can't produce, or side
   * quests of the main process.
   */
  optional?: boolean;
  /**
   * Marks this as a generated stand-in endpoint minting placeholder values — not part of the
   * real process. The emulator badges it and the contract-wiring bookkeeping treats it as a
   * producer like any other.
   */
  stub?: boolean;
  /** Human description → OpenAPI operation description. */
  description?: string;
  /**
   * Per-field input source (OpenAPI's parameter model). A field named here is bound from the URL
   * path / query string / request header instead of the JSON body, then merged back into the
   * input DTO server-side (so the handler still receives one validated DTO). Omitted ⇒ body — the
   * default, so endpoints without it route exactly as before. The route's `:field` / `:field{.+}`
   * segments are provided by `path`; this map tells the binder where to read each field.
   */
  sources?: Record<string, FieldSource>;
}

/** Normalized process metadata attached to each `@Endpoint` handler. */
export interface ProcessMetadata {
  order?: number;
  /** Normalized dependsOn — an inner array is an OR-group (any member unlocks). */
  dependsOn: (string | string[])[];
  bind: Record<string, string | string[]>;
  flows: string[];
  optional: boolean;
  stub: boolean;
  method: EndpointMethod;
  path: string;
  /** Per-field input source. Present only when at least one field is non-body, so endpoints
   * without field-source binding keep their existing x-keep-process shape. */
  sources?: Record<string, FieldSource>;
}

const MAPPING: Record<EndpointMethod, (endpoint?: string) => MethodDecorator> =
  {
    get: Get,
    post: Post,
    put: Put,
    patch: Patch,
    delete: Delete,
  };

/**
 * Decorate a controller handler to expose it as an HTTP endpoint with Swagger schemas + process
 * metadata. Type the handler's parameter as the input DTO (`create(body: CreateUserDto)`) — the
 * decorator wires `@Body()` for you; do not add it yourself.
 */
export function Endpoint(opts: EndpointOptions = {}): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    const method = opts.method ?? "post";
    const path = opts.path ?? "";
    const sources = opts.sources ?? {};
    const hasSources = Object.keys(sources).length > 0;

    // 1) danet route metadata — makes the handler routable AND gives Swagger its path + method.
    MAPPING[method](path)(target, propertyKey, descriptor);

    // 2) request input — inject it at runtime and declare its body schema for Swagger.
    if (opts.input) {
      const InputDto = opts.input;
      if (hasSources) {
        // Field-source binding: assemble the body with the path/query/header-sourced fields into
        // the full input DTO ourselves, then validate via rune `assert` (a failure surfaces as the
        // same RuneAssertError → HTTP 422 every other validated seam uses). danet's `@Body()` is
        // NOT wired — it would 400 on a field that lives in the URL/header, not the JSON body.
        const bindSourcedInput = createParamDecorator(async (context) => {
          let body: Record<string, unknown> = {};
          try {
            const json = await context.req.json();
            if (json && typeof json === "object" && !Array.isArray(json)) {
              body = json as Record<string, unknown>;
            }
          } catch {
            // No body or not JSON (e.g. a GET): the sourced fields supply everything.
          }
          const read = {
            param: (n: string) => context.req.param(n),
            query: (n: string) => context.req.query(n),
            header: (n: string) => context.req.header(n),
          };
          const proto =
            (InputDto as unknown as { prototype: object }).prototype;
          const merged = assembleSourcedInput(
            body,
            sources,
            read,
            (field, raw) =>
              coerceToType(
                raw,
                Reflect.getMetadata("design:type", proto, field),
              ),
          );
          return assert(InputDto as unknown as { new (): object }, merged);
        });
        bindSourcedInput()(target, propertyKey as string, 0);
      } else {
        Body()(target, propertyKey as string, 0);
      }
      // BodyType declares the requestBody schema for Swagger. For source-bound endpoints the doc
      // builder strips the path/query/header fields from that schema (they become parameters).
      BodyType(InputDto as unknown as Parameters<typeof BodyType>[0])(
        target,
        propertyKey,
        descriptor,
      );
    }

    // 3) response schema for Swagger.
    if (opts.output) ReturnedType(opts.output)(target, propertyKey, descriptor);

    // 4) operation description.
    if (opts.description) {
      Description(opts.description)(target, propertyKey, descriptor);
    }

    // 5) process metadata for the emulator + headless runner.
    const toList = (v?: string | string[]) =>
      v == null ? [] : Array.isArray(v) ? v : [v];
    const meta: ProcessMetadata = {
      order: opts.order,
      // Preserve OR-group arrays (don't flatten): a string → [string]; a list passes through.
      dependsOn: opts.dependsOn == null
        ? []
        : Array.isArray(opts.dependsOn)
        ? opts.dependsOn
        : [opts.dependsOn],
      bind: opts.bind ?? {},
      flows: toList(opts.flows),
      optional: opts.optional ?? false,
      stub: opts.stub ?? false,
      method,
      path,
      // Carry field sources only when present, so non-bound endpoints keep their exact metadata.
      ...(hasSources ? { sources } : {}),
    };
    Reflect.defineMetadata(PROCESS_METADATA_KEY, meta, target, propertyKey);
  };
}

/** Reads the process metadata stamped by `@Endpoint`, if any. */
export function getProcessMetadata(
  // deno-lint-ignore ban-types
  target: Object,
  propertyKey: string,
): ProcessMetadata | undefined {
  return Reflect.getMetadata(PROCESS_METADATA_KEY, target, propertyKey);
}

/**
 * Class decorator turning a plain class into a danet controller mounted at `surface`. Optionally
 * attaches a Swagger module description.
 */
export function EndpointController(
  surface: string,
  opts?: { description?: string },
): ClassDecorator {
  return (target) => {
    Controller(surface)(
      target as unknown as Parameters<ReturnType<typeof Controller>>[0],
    );
    if (opts?.description) SwaggerDescription(opts.description)(target);
  };
}

/**
 * Convenience: wrap one or more endpoint controllers in a danet `@Module`, named so the generated
 * Swagger doc + `/docs/<name>` route read meaningfully (one module per rune). Pass the result to
 * `bootstrapServer`.
 */
export function endpointModule(name: string, controllers: Type[]): Type {
  @Module({ controllers })
  class EndpointModule {}
  const moduleName = name.endsWith("Module") ? name : `${name}Module`;
  Object.defineProperty(EndpointModule, "name", { value: moduleName });
  return EndpointModule as unknown as Type;
}

/**
 * Compose several endpoint modules (one per rune) into a single root module for
 * `bootstrapServer`. Each child keeps its own Swagger doc and `/docs/<module>` page; the
 * wrapper has no controllers of its own, so it never appears in the docs index.
 */
export function appModule(name: string, modules: Type[]): Type {
  @Module({ imports: modules })
  class AppModule {}
  const base = name ? name.charAt(0).toUpperCase() + name.slice(1) : "";
  Object.defineProperty(AppModule, "name", { value: `${base}AppModule` });
  return AppModule as unknown as Type;
}

// ---- WebSocket endpoints (danet @WebSocketController / @OnWebSocketMessage) ----
//
// A rune `[ENT:ws]` socket becomes a live WebSocket controller: one handshake route danet upgrades,
// then each inbound `{topic, data}` frame is dispatched to the `@WsEndpoint` whose topic matches.
// Unlike `@Endpoint`, a WS handler is NOT an HTTP route — it carries no verb and never enters the
// OpenAPI document. Whatever the handler returns is serialized and sent back to the SENDER (danet
// has no built-in broadcast); a `void` handler stays silent.

/** Where a `@WsEndpoint` handler's metadata is stored, keyed on (controller prototype, method). */
export const WS_PROCESS_METADATA_KEY = "keep:ws-process";

export interface WsEndpointOptions {
  /** Message topic this handler answers — the `topic` of an inbound `{topic, data}` frame. */
  topic: string;
  /** Inbound message DTO. The `data` payload is validated against it (a failure is a RuneAssertError). */
  input?: Type;
  /** Reply DTO (informational). Whatever the handler returns is sent back to the sender as JSON. */
  output?: Type;
}

/** Metadata attached to each `@WsEndpoint` handler (the WS analogue of ProcessMetadata). */
export interface WsProcessMetadata {
  kind: "ws";
  topic: string;
}

/**
 * Decorate a controller method as the WebSocket handler for `opts.topic`. Composes danet's
 * `@OnWebSocketMessage` (topic routing over one upgraded socket) with rune `assert` on the inbound
 * payload: type the handler's parameter as the input DTO (`send(data: ChatDto)`) and the decorator
 * injects the validated message — do NOT add a danet `@Body()`. The per-message context is synthetic
 * (no real request body), so the payload is read from danet's `websocketMessage` on the execution
 * context. Whatever the handler returns is sent back to the sender; a `void` handler stays silent.
 */
export function WsEndpoint(opts: WsEndpointOptions): MethodDecorator {
  return (target, propertyKey, descriptor) => {
    // 1) danet WS topic metadata — routes matching `{topic}` frames to this handler.
    OnWebSocketMessage(opts.topic)(target, propertyKey, descriptor);

    // 2) inbound payload — validate danet's per-message `websocketMessage` as the input DTO via
    //    rune `assert` (a RuneAssertError runs through the controller's exception filters).
    if (opts.input) {
      const InputDto = opts.input;
      const bindMessage = createParamDecorator((context) => {
        const data = context.websocketMessage ?? {};
        return assert(InputDto as unknown as { new (): object }, data);
      });
      bindMessage()(target, propertyKey as string, 0);
    }

    // 3) handler metadata (a WS topic, distinct from the HTTP process graph).
    const meta: WsProcessMetadata = { kind: "ws", topic: opts.topic };
    Reflect.defineMetadata(WS_PROCESS_METADATA_KEY, meta, target, propertyKey);
  };
}

/** Reads the metadata stamped by `@WsEndpoint`, if any. */
export function getWsProcessMetadata(
  // deno-lint-ignore ban-types
  target: Object,
  propertyKey: string,
): WsProcessMetadata | undefined {
  return Reflect.getMetadata(WS_PROCESS_METADATA_KEY, target, propertyKey);
}

/**
 * Class decorator turning a plain class into a danet WebSocket controller served at `path` (the
 * handshake route — danet upgrades a single GET there and dispatches each `{topic, data}` frame to
 * the matching `@WsEndpoint`). `path` MUST be non-empty: danet routes a controller to its WebSocket
 * transport only when the `websocket-endpoint` metadata is truthy, so an empty path would silently
 * fall back to the HTTP router.
 */
export function WsEndpointController(path: string): ClassDecorator {
  if (!path) {
    throw new Error(
      "WsEndpointController requires a non-empty handshake path (an empty path would route to HTTP)",
    );
  }
  return (target) => {
    WebSocketController(path)(target as unknown as object);
  };
}
