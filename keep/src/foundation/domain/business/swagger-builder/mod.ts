import "#reflect-metadata";
import { getMetadataStorage } from "class-validator";
import type { Server } from "@foundation/domain/business/server/mod.ts";
import type { OpenApiDocument, OpenApiSchema, Type } from "@types";
import { Crawler } from "@foundation/domain/business/crawler/mod.ts";
import { DanetDocumentBuilder } from "@foundation/domain/business/document-builder/mod.ts";
import { IndexPageBuilder } from "@foundation/domain/business/index-page-builder/mod.ts";

/**
 * @danet/swagger only honors its own `@Optional()` decorator when computing a
 * schema's `required` array — plain class-validator DTOs (everything rune
 * generates) mark optionality with `@IsOptional()`, which it never reads, so
 * every property lands in `required`. That lie cascades: the emulator trusts
 * `required` to decide which fields belong in a default request body, so
 * optional numbers prefill as 0 and immediately fail their own validation.
 * Collect the truth from class-validator's metadata storage (keyed by class
 * name — the same name the $refs use) so build() can repair the documents.
 */
export function optionalPropsByClassName(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // `validationMetadatas` is TS-private but runtime-stable: a Map of
  // target constructor -> ValidationMetadata[].
  const storage = getMetadataStorage() as unknown as {
    validationMetadatas: Map<
      unknown,
      Array<{ type: string; propertyName: string }>
    >;
  };
  for (const [target, metas] of storage.validationMetadatas.entries()) {
    const name = typeof target === "function" ? target.name : String(target);
    for (const m of metas) {
      if (m.type !== "conditionalValidation") continue; // @IsOptional marker
      if (!out.has(name)) out.set(name, new Set());
      out.get(name)!.add(m.propertyName);
    }
  }
  return out;
}

/** Strip class-validator-optional properties from every schema's `required`. */
export function honorOptionalProps(
  doc: unknown,
  optionals: Map<string, Set<string>>,
): void {
  const schemas = (doc as {
    components?: { schemas?: Record<string, { required?: string[] }> };
  }).components?.schemas;
  if (!schemas) return;
  for (const [name, schema] of Object.entries(schemas)) {
    const opt = optionals.get(name);
    if (!opt || !Array.isArray(schema.required)) continue;
    schema.required = schema.required.filter((p) => !opt.has(p));
    if (schema.required.length === 0) delete schema.required;
  }
}

/**
 * Apply field-source binding to a served doc. For each operation that declares input sources
 * (`x-keep-process.sources`), move the path/query/header-sourced fields OUT of the requestBody and
 * into typed parameters, so the OpenAPI doc reflects how each field is actually sent — path params
 * are already emitted by @danet/swagger from the `:field` route segment, so this fills in query +
 * header params (deduped) and trims the requestBody. The shared component schema is left intact;
 * the requestBody's `$ref` is replaced with an inline object of just the body fields, so a DTO
 * reused elsewhere keeps its full shape. A no-op for ordinary (all-body) endpoints.
 */
export function applyFieldSources(doc: OpenApiDocument): void {
  const schemas = (doc.components?.schemas ?? {}) as Record<
    string,
    OpenApiSchema
  >;
  const methods = ["get", "post", "put", "patch", "delete"] as const;
  for (const pathItem of Object.values(doc.paths ?? {})) {
    for (const method of methods) {
      const op = pathItem[method];
      const sources = op?.["x-keep-process"]?.sources;
      if (!op || !sources || Object.keys(sources).length === 0) continue;

      const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
      const comp = reqSchema?.$ref
        ? schemas[reqSchema.$ref.split("/").pop() ?? ""]
        : reqSchema;
      const props = (comp?.properties ?? {}) as Record<
        string,
        { type?: string; description?: string; example?: unknown }
      >;
      const required = comp?.required ?? [];

      // Parameters: path params are already present (danet derives them from the route); add the
      // query + header params, and dedupe by (in, name) so we never double an auto-emitted one.
      // Carry each field's example across so headless walks + the cake can prefill the param.
      op.parameters = op.parameters ?? [];
      const byKey = new Map(op.parameters.map((p) => [`${p.in}:${p.name}`, p]));
      for (const [field, source] of Object.entries(sources)) {
        const loc = source === "path*" ? "path" : source; // path*/path → path
        const example = props[field]?.example;
        const existing = byKey.get(`${loc}:${field}`);
        if (existing) {
          // danet auto-emitted this path param — enrich it with the field's example.
          if (example !== undefined && existing.example === undefined) {
            existing.example = example;
          }
          continue;
        }
        op.parameters.push({
          name: field,
          in: loc,
          required: loc === "path" ? true : required.includes(field),
          schema: { type: props[field]?.type ?? "string" },
          description: props[field]?.description ?? "",
          ...(example !== undefined ? { example } : {}),
        });
      }

      // requestBody: keep only the body-sourced fields (inline, so the shared component is intact).
      if (!op.requestBody) continue;
      const bodyFields = Object.keys(props).filter((k) => !(k in sources));
      if (bodyFields.length === 0) {
        delete op.requestBody;
        continue;
      }
      const inlineProps: Record<string, unknown> = {};
      for (const k of bodyFields) inlineProps[k] = props[k];
      const inlineRequired = required.filter((k) => !(k in sources));
      op.requestBody.content!["application/json"].schema = {
        type: "object",
        properties: inlineProps,
        ...(inlineRequired.length ? { required: inlineRequired } : {}),
      };
    }
  }
}

export class SwaggerBuilder {
  private crawler: Crawler;
  private documentBuilder: DanetDocumentBuilder;
  private indexPageBuilder: IndexPageBuilder;

  constructor(...filters: string[]) {
    this.crawler = new Crawler(...filters);
    this.documentBuilder = new DanetDocumentBuilder();
    // particleCount left at the builder's modest default — 100 just bloated every rendered page.
    // Relative prefix: the index is served at "/docs" standalone and "/api/docs" mounted under
    // a host, and "docs/app" resolves correctly from both — "/docs/app" would escape the mount.
    this.indexPageBuilder = new IndexPageBuilder({
      prefix: "docs/",
    });
  }

  async build(server: Server) {
    // Skip pure composition wrappers (imports but no controllers of their own — e.g. the
    // appModule() root): they have nothing to document and would render an empty card.
    const allModules = this.crawler.crawl(server.modules).filter((m: Type) => {
      const meta = Reflect.getMetadata("module", m) as
        | { imports?: unknown[]; controllers?: unknown[] }
        | undefined;
      const isWrapper = (meta?.imports?.length ?? 0) > 0 &&
        (meta?.controllers?.length ?? 0) === 0;
      return !isWrapper;
    });
    const specs = allModules.map((m: Type) =>
      this.documentBuilder.createSpec(m)
    );
    const docs$ = specs.map((s) => this.documentBuilder.createDocument(s));
    const swaggerDocs = await Promise.all(docs$);
    // class-validator @IsOptional is as authoritative as @Optional() — see
    // optionalPropsByClassName above. (Entries are {doc, path} wrappers.)
    const optionals = optionalPropsByClassName();
    swaggerDocs.forEach((entry) => honorOptionalProps(entry.doc, optionals));
    // Field-source binding: move path/query/header-sourced fields out of the body into params so
    // the served doc matches how each field is sent (and the cake renders them at the right place).
    swaggerDocs.forEach((entry) =>
      applyFieldSources(entry.doc as unknown as OpenApiDocument)
    );
    // Index from the CRAWLED modules, not server.moduleNames — the server only
    // registers the root module, so an imported module would get a /docs/<name>
    // page but no card on the index.
    // The system map link is relative for the same mount-prefix reason as the cards above.
    const docsIndexHtml = this.indexPageBuilder.build(
      allModules.map((m) => m.name),
      { mapHref: "docs/_map" },
    );
    return { swaggerDocs, docsIndexHtml };
  }
}
