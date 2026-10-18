import { SpecBuilder, SwaggerModule } from "#danet/swagger";
import "#reflect-metadata";
import type { Type } from "@types";
import { DanetApplication, Module } from "#danet/core";
import { getSwaggerDescription } from "@foundation/domain/business/swagger-description/mod.ts";
import {
  getProcessMetadata,
  type ProcessMetadata,
} from "@foundation/domain/business/endpoint-decorator/mod.ts";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

// danet stores each handler's route under this Reflect key on the method function.
const ROUTE_METADATA_KEY = "endpoint";

/**
 * Hono routes a catch-all path field as `:field{.+}` (slash-capturing), but @danet/swagger parses
 * routes with path-to-regexp@6, which THROWS on the brace form (and on a bare `*`). Rewrite each
 * handler's stored route to the equivalent paren form `:field(.*)` for the duration of doc
 * generation — both yield the same `{field}` OpenAPI path param — then restore via the returned
 * thunks so the SERVED Hono route keeps its slash-capturing brace form. A no-op for ordinary
 * routes (no braces), so non-catch-all endpoints are untouched.
 */
function swaggerSafeRoutes(mod: Type): Array<() => void> {
  const meta = Reflect.getMetadata("module", mod) ?? {};
  const controllers: Type[] = meta.controllers ?? [];
  const restores: Array<() => void> = [];
  for (const controller of controllers) {
    const proto = controller.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const fn = (proto as Record<string, unknown>)[name];
      const route = Reflect.getMetadata(ROUTE_METADATA_KEY, fn as object);
      if (typeof route !== "string" || !route.includes("{")) continue;
      const safe = route.replace(/\{[^}]*\}/g, "(.*)");
      Reflect.defineMetadata(ROUTE_METADATA_KEY, safe, fn as object);
      restores.push(() =>
        Reflect.defineMetadata(ROUTE_METADATA_KEY, route, fn as object)
      );
    }
  }
  return restores;
}

// Refcount for the console.log silence in setupFacade. Composed apps init several throwaway
// facades CONCURRENTLY (Promise.all over modules); only the 0→1 transition saves the real
// console.log and only the 1→0 transition restores it, so overlapping inits can't capture
// each other's no-op as the "original".
let facadeSilenceDepth = 0;
let realConsoleLog: typeof console.log | undefined;

/**
 * Walk a module's controllers and copy each `@Endpoint` handler's process metadata onto the
 * matching OpenAPI operation as the `x-keep-process` vendor extension (matched by operationId,
 * which danet sets to the handler's method name). This is what the per-module emulator UI and the
 * headless runner read to order and chain the endpoints — so it travels with the spec, single
 * source of truth. Modules with no `@Endpoint` handlers are left untouched.
 */
function attachProcessMetadata(
  doc: { paths?: Record<string, Record<string, unknown>> },
  mod: Type,
): void {
  const meta = Reflect.getMetadata("module", mod) ?? {};
  const controllers: Type[] = meta.controllers ?? [];
  const byOperationId = new Map<string, ProcessMetadata>();
  for (const controller of controllers) {
    const proto = controller.prototype;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor") continue;
      const process = getProcessMetadata(proto, name);
      if (process) byOperationId.set(name, process);
    }
  }
  if (byOperationId.size === 0) return;
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as { operationId?: string } | undefined;
      if (!op?.operationId) continue;
      const process = byOperationId.get(op.operationId);
      if (!process) continue;
      (op as Record<string, unknown>)["x-keep-process"] = process;
      // The openness marker travels as its OWN extension, separate from the
      // process metadata, because it is read by a different consumer for a
      // different purpose: `x-keep-process` drives the emulator and the runner,
      // `x-bedrock-auth` is where keep's policy table comes from (D-3). Absent
      // means the slot default — bedrock never has to guess what silence meant.
      if (process.access !== undefined) {
        (op as Record<string, unknown>)["x-bedrock-auth"] = {
          access: process.access,
        };
      }
    }
  }
}

// Type-only helper: the shape returned by SpecBuilder.build(), used to type Spec.value.
const emptySpec = (): ReturnType<SpecBuilder["build"]> =>
  new SpecBuilder().build();
type Document = Awaited<ReturnType<typeof SwaggerModule.createDocument>>;

class Spec {
  static getCleanName(name: string): string {
    return name.replace(/Module$/, "");
  }
  constructor(
    public module: Type,
    public value: ReturnType<typeof emptySpec>,
  ) {}
}

export class DanetDocumentBuilder {
  createSpec(target: Type, description?: string, version = "1.0"): Spec {
    const name = Spec.getCleanName(target.name);
    const desc = description ?? getSwaggerDescription(target) ??
      "Auto-generated docs";
    const value = new SpecBuilder()
      .setTitle(name)
      .setDescription(desc)
      .setVersion(version)
      .addSecurity("basic", { type: "http", scheme: "basic" })
      .build();
    return new Spec(target, value);
  }

  private async setupFacade(mod: Type) {
    const meta = Reflect.getMetadata("module", mod) ?? {};
    // A standalone copy of the module's metadata with `imports` stripped, so we can build the
    // Swagger doc for THIS module in isolation (without recursively pulling in its imports).
    const facadeMetadata = {
      ...meta,
      imports: [],
      controllers: meta.controllers ? [...meta.controllers] : undefined,
      providers: meta.providers ? [...meta.providers] : undefined,
      exports: meta.exports ? [...meta.exports] : undefined,
    };
    @Module(facadeMetadata)
    class FacadeModule {}
    const host = new DanetApplication();
    // DanetApplication.init() prints banner/init noise to console.log; silence it just for
    // this throwaway facade init so building docs doesn't spam the host app's logs. The swap
    // is REFCOUNTED: composed apps build all module docs concurrently, and per-call
    // save/restore would let the second facade capture the first's no-op as its "original"
    // and restore that — leaving console.log dead for the host app forever.
    if (facadeSilenceDepth++ === 0) {
      realConsoleLog = console.log;
      console.log = () => {};
    }
    try {
      await host.init(FacadeModule);
      return host;
    } finally {
      if (--facadeSilenceDepth === 0 && realConsoleLog) {
        console.log = realConsoleLog;
        realConsoleLog = undefined;
      }
    }
  }

  normalizePath = (
    path: string,
  ): string => (path.startsWith("/") ? path : `/${path}`);

  async createDocument(spec: Spec): Promise<{ doc: Document; path: string }> {
    const swaggerModuleHost = await this.setupFacade(spec.module);
    const rawPath = `/${Spec.getCleanName(spec.module.name).toLowerCase()}`;
    // Make brace catch-all routes parseable by @danet/swagger's path-to-regexp, then restore.
    const restoreRoutes = swaggerSafeRoutes(spec.module);
    let doc: Document;
    try {
      doc = await SwaggerModule.createDocument(swaggerModuleHost, spec.value);
    } finally {
      for (const restore of restoreRoutes) restore();
    }
    attachProcessMetadata(
      doc as unknown as { paths?: Record<string, Record<string, unknown>> },
      spec.module,
    );
    return {
      doc,
      path: this.normalizePath(rawPath),
    };
  }

  package(doc: Document, prefix: string): { doc: Document; path: string } {
    const normalizedPrefix = this.normalizePath(prefix);
    const path =
      `${normalizedPrefix.toLowerCase()}/${doc.info.title.toLowerCase()}`;
    return { doc, path };
  }
}
