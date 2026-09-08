/**
 * Distill a generated per-module OpenAPI document (with `x-keep-process`) into a flat list of
 * endpoints the emulator UI and the headless runner both consume. Pure: spec in, endpoints out.
 */

import type { OpenApiDocument, OpenApiOperation } from "@types";

/** One request-body field with enough schema info to build a typed example value. */
export interface SpecField {
  name: string;
  /** JSON-schema type: "string" | "number" | "integer" | "boolean" | "array" | "object" | "". */
  type: string;
  required: boolean;
  /** Example value derived from the schema: its example/default, enum[0], or the type's zero value. */
  example: unknown;
}

/** One path / query / header parameter declared on the operation. */
export interface SpecParam {
  name: string;
  in: string;
  required: boolean;
  /** Example value carried from the field's `[TYP:example=...]`, so headless walks and the cake
   * can prefill it (path/query/header values come from no body). Absent when the field has none. */
  example?: unknown;
}

export interface SpecEndpoint {
  /** OpenAPI operationId — the handler method name; used as the stable endpoint id. */
  id: string;
  /** Upper-case HTTP verb. */
  method: string;
  /** Spec path, app-root-relative, e.g. "/users/fetch". */
  path: string;
  order?: number;
  dependsOn: (string | string[])[];
  /**
   * Output→input wiring: `"endpointId.field"`, `"$externalInput"`, or an array of
   * alternatives (first resolvable wins).
   */
  bind: Record<string, string | string[]>;
  /** Named branches this endpoint belongs to; empty = part of every flow. */
  flows: string[];
  /** Attempted but not required by run-all / the headless runner. */
  optional: boolean;
  /** A generated stand-in endpoint minting placeholder values — not part of the real process. */
  stub: boolean;
  /** Top-level field names of the request body DTO (for the request editor + curl). */
  inputFields: string[];
  /** Top-level field names of the 200 response DTO. */
  outputFields: string[];
  /** Request body fields with schema types + example values (drives the typed body editor). */
  inputSchema: SpecField[];
  /** Path/query parameters declared on the operation. */
  params: SpecParam[];
  description?: string;
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

type SchemaNode = {
  $ref?: string;
  /** Generators sometimes emit non-string types (e.g. ["string","null"]) — typeOf() normalizes. */
  type?: string | string[];
  example?: unknown;
  default?: unknown;
  enum?: unknown[];
  properties?: Record<string, SchemaNode>;
  required?: string[];
  items?: SchemaNode;
};

function resolveRef(
  doc: OpenApiDocument,
  node: SchemaNode | undefined,
): SchemaNode | undefined {
  if (!node?.$ref) return node;
  const name = node.$ref.split("/").pop();
  if (!name) return undefined;
  return doc.components?.schemas?.[name] as SchemaNode | undefined;
}

/**
 * The effective JSON type of a schema node. Generators don't always write `type` — a node with
 * `properties` is an object and one with `items` is an array — and some emit `type` as an array;
 * normalize all of that to one string.
 */
function typeOf(schema: SchemaNode): string {
  const raw = schema.type;
  const declared = typeof raw === "string"
    ? raw
    : Array.isArray(raw)
    ? (raw as unknown[]).find((t): t is string => typeof t === "string") ?? ""
    : "";
  if (declared) return declared;
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "";
}

/**
 * A representative value for a schema node: its declared example/default, the first enum member,
 * or the type's zero value (objects recurse over their properties, depth-limited).
 */
export function exampleFromSchema(
  doc: OpenApiDocument,
  node: SchemaNode | undefined,
  depth = 0,
): unknown {
  const schema = resolveRef(doc, node);
  if (!schema || depth > 3) return "";
  if (schema.example !== undefined) return schema.example;
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (typeOf(schema)) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return [];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [name, prop] of Object.entries(schema.properties ?? {})) {
        out[name] = exampleFromSchema(doc, prop, depth + 1);
      }
      return out;
    }
    default:
      return "";
  }
}

/** Top-level fields of a schema node — a `$ref` to a component OR an inline object. (Field-source
 * binding replaces a requestBody `$ref` with an inline object of just the body fields, so we must
 * read both forms.) */
function fieldsFromSchema(
  doc: OpenApiDocument,
  node: SchemaNode | undefined,
): SpecField[] {
  const schema = node?.$ref ? resolveRef(doc, node) : node;
  if (!schema?.properties) return [];
  const required = new Set(schema.required ?? []);
  return Object.entries(schema.properties).map(([name, prop]) => {
    const resolved = resolveRef(doc, prop);
    return {
      name,
      type: resolved ? typeOf(resolved) : "",
      required: required.has(name),
      example: exampleFromSchema(doc, prop),
    };
  });
}

function fieldsFromRef(
  doc: OpenApiDocument,
  ref: string | undefined,
): SpecField[] {
  return ref ? fieldsFromSchema(doc, { $ref: ref }) : [];
}

function paramsFromOp(op: OpenApiOperation): SpecParam[] {
  // path/query/header are all editable request inputs once an endpoint declares field sources
  // (a rune `[TYP:from=...]` field). Other `in` values (cookie, …) aren't part of rune's model.
  return (op.parameters ?? [])
    .filter((p) => p.in === "path" || p.in === "query" || p.in === "header")
    .map((p) => {
      const example = p.example ??
        (p.schema as { example?: unknown } | undefined)?.example;
      return {
        name: p.name,
        in: p.in,
        required: p.required ?? false,
        ...(example !== undefined ? { example } : {}),
      };
    });
}

/** Extract endpoints from one module document, in declaration order (callers re-order via processOrder). */
export function endpointsFromDoc(doc: OpenApiDocument): SpecEndpoint[] {
  const endpoints: SpecEndpoint[] = [];
  for (const [path, item] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op?.operationId) continue;
      const process = op["x-keep-process"];
      const reqSchema = op.requestBody?.content?.["application/json"]?.schema;
      const resRef = (op.responses?.["200"] as
        | { content?: Record<string, { schema?: { $ref?: string } }> }
        | undefined)?.content?.["application/json"]?.schema?.$ref;
      const inputSchema = fieldsFromSchema(
        doc,
        reqSchema as SchemaNode | undefined,
      );
      endpoints.push({
        id: op.operationId,
        method: method.toUpperCase(),
        path,
        order: process?.order,
        dependsOn: process?.dependsOn ?? [],
        bind: process?.bind ?? {},
        flows: process?.flows ?? [],
        optional: process?.optional ?? false,
        stub: process?.stub ?? false,
        inputFields: inputSchema.map((f) => f.name),
        outputFields: fieldsFromRef(doc, resRef).map((f) => f.name),
        inputSchema,
        params: paramsFromOp(op),
        description: op.description,
      });
    }
  }
  return endpoints;
}
