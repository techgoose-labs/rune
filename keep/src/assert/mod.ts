// Rune assert runtime — runtime validation for the seams between generated
// classes: request inputs, data-adapter reads/writes, core outputs. Published
// as the `@techgoose-labs/rune/assert` subpath; rune-generated projects reach
// it through their `#assert` import-map alias, and keep's bootstrapServer
// maps a thrown RuneAssertError to HTTP 422.
//
// IMPORTANT: the single-copy invariant. The consumer's DTOs and this module
// must resolve class-validator/class-transformer to ONE copy each:
// class-transformer's @Type metadata store is per-copy (a second copy sees no
// @Type registrations and nested validation silently degrades). Locally the
// bare specifiers below resolve through keep's import map; `deno publish`
// bakes them to the npm: ranges in deno.json — so those ranges MUST stay
// equal to the ones rune's sync writes into generated projects
// (npm:class-validator@^0.14 / npm:class-transformer@^0.5), letting Deno
// dedupe both resolution paths to the same package version.
// Side-effect import: class-transformer's @Type reads Reflect.getMetadata at
// decoration time; loading the polyfill here covers every consumer of assert.
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync, type ValidationError } from "class-validator";

/** One leaf validation failure, with a dotted path into the object. */
export interface AssertFailure {
  /** e.g. "title", "task.title", "lines.1.qty"; "" for a non-object input. */
  path: string;
  /** The class-validator constraint id (e.g. "isString"), or "type". */
  constraint: string;
  message: string;
}

/**
 * Thrown when a value does not satisfy its contract. keep recognizes this
 * error (by name + failures shape) and maps it to HTTP 422.
 */
export class RuneAssertError extends Error {
  override readonly name = "RuneAssertError";
  /** The contract that failed, e.g. "TaskDto", "TaskDto[]", "string". */
  readonly target: string;
  /** Where in the flow the check ran, e.g. "task.load" — set by generated code. */
  readonly context: string | null;
  readonly failures: AssertFailure[];

  constructor(target: string, failures: AssertFailure[], context?: string) {
    const at = context ? ` (at ${context})` : "";
    const detail = failures
      .map((f) => (f.path ? `${f.path}: ${f.message}` : f.message))
      .join("; ");
    super(`Validation failed for ${target}${at}: ${detail}`);
    this.target = target;
    this.context = context ?? null;
    this.failures = failures;
  }
}

// RUNE_ASSERT=off turns every assert into a passthrough (trusted prod mode).
// Read once at module load; absence of env permission means asserts stay ON.
const enabled = (() => {
  try {
    return Deno.env.get("RUNE_ASSERT") !== "off";
  } catch {
    return true;
  }
})();

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return typeof value;
}

// Flatten class-validator's error tree into leaf failures with dotted paths.
// Nested errors live in .children (constraints only at the leaves).
function flatten(errors: ValidationError[], prefix: string): AssertFailure[] {
  const out: AssertFailure[] = [];
  for (const e of errors) {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    for (const [constraint, message] of Object.entries(e.constraints ?? {})) {
      out.push({ path, constraint, message });
    }
    if (e.children && e.children.length > 0) {
      out.push(...flatten(e.children, path));
    }
  }
  return out;
}

// deno-lint-ignore no-explicit-any
type Ctor<T> = new (...args: any[]) => T;

function assertInstance<T extends object>(
  cls: Ctor<T>,
  plain: unknown,
  context?: string,
): T {
  if (!enabled) return plain as T;
  let instance: T;
  if (plain instanceof cls) {
    // Already an instance: validate in place, preserve identity. Note that
    // whitelist validation strips undecorated properties from the instance.
    instance = plain;
  } else if (
    typeof plain === "object" && plain !== null && !Array.isArray(plain)
  ) {
    instance = plainToInstance(cls, plain, { enableImplicitConversion: false });
  } else {
    throw new RuneAssertError(
      cls.name,
      [{
        path: "",
        constraint: "type",
        message: `expected an object, got ${typeOf(plain)}`,
      }],
      context,
    );
  }
  // whitelist strips properties with no decorator — the DTO class is the contract; undeclared
  // data does not ride between classes. Fields meant to carry free-form data are generated with
  // @Allow().
  //
  // A [DTO:open] class (rune's opaque-inbound-payload marker `static __keepOpen = true`) passes
  // THIS DTO's own undeclared fields: we validate strictly (whitelist on) — so declared fields,
  // and any declared *nested* DTO, keep their own contract — then re-attach the inbound payload's
  // extra top-level fields afterwards. We snapshot those BEFORE validation because the whitelist
  // strip mutates `instance`, which may be the same object as `plain`. Absent marker ⇒ plain
  // strict whitelist, so behaviour degrades gracefully across the rune/keep release boundary. The
  // marker takes effect at the asserted seam; an open DTO used only as a nested field is governed
  // by its parent's contract (class-validator's whitelist is one tree-wide flag).
  const open = (cls as { __keepOpen?: boolean }).__keepOpen === true;
  const openSrc: Record<string, unknown> | null =
    open && typeof plain === "object" && plain !== null && !Array.isArray(plain)
      ? { ...(plain as Record<string, unknown>) }
      : null;
  const errors = validateSync(instance, { whitelist: true });
  if (errors.length > 0) {
    throw new RuneAssertError(cls.name, flatten(errors, ""), context);
  }
  if (openSrc) {
    const inst = instance as Record<string, unknown>;
    for (const k of Object.keys(openSrc)) {
      // Own-property check, not the prototype-aware `in`: an inbound field named like an
      // Object.prototype member ("toString", "constructor", …) is a legitimate extra and must
      // re-attach as the instance's own value, not be treated as already-present.
      if (!Object.prototype.hasOwnProperty.call(inst, k)) inst[k] = openSrc[k];
    }
  }
  return instance;
}

function primitiveFailure(
  target: string,
  value: unknown,
  context?: string,
): RuneAssertError {
  return new RuneAssertError(
    target,
    [{
      path: "",
      constraint: "type",
      message: `expected ${target}, got ${typeOf(value)}`,
    }],
    context,
  );
}

interface Assert {
  /** Validate a plain object (or instance) against a DTO class; returns the typed instance. */
  <T extends object>(cls: Ctor<T>, plain: unknown, context?: string): T;
  /** Validate every element of an array against a DTO class. */
  arrayOf<T extends object>(
    cls: Ctor<T>,
    plain: unknown,
    context?: string,
  ): T[];
  string(value: unknown, context?: string): string;
  /** Finite numbers only — NaN and Infinity are rejected. */
  number(value: unknown, context?: string): number;
  boolean(value: unknown, context?: string): boolean;
  uint8Array(value: unknown, context?: string): Uint8Array;
}

const assert: Assert = Object.assign(assertInstance, {
  arrayOf<T extends object>(
    cls: Ctor<T>,
    plain: unknown,
    context?: string,
  ): T[] {
    if (!enabled) return plain as T[];
    const target = `${cls.name}[]`;
    if (!Array.isArray(plain)) {
      throw new RuneAssertError(
        target,
        [{
          path: "",
          constraint: "type",
          message: `expected an array, got ${typeOf(plain)}`,
        }],
        context,
      );
    }
    const failures: AssertFailure[] = [];
    const out: T[] = [];
    plain.forEach((item, i) => {
      try {
        out.push(assertInstance(cls, item, context));
      } catch (e) {
        if (e instanceof RuneAssertError) {
          for (const f of e.failures) {
            failures.push({
              ...f,
              path: f.path ? `${i}.${f.path}` : String(i),
            });
          }
        } else throw e;
      }
    });
    if (failures.length > 0) {
      throw new RuneAssertError(target, failures, context);
    }
    return out;
  },

  string(value: unknown, context?: string): string {
    if (!enabled) return value as string;
    if (typeof value !== "string") {
      throw primitiveFailure("string", value, context);
    }
    return value;
  },

  number(value: unknown, context?: string): number {
    if (!enabled) return value as number;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      throw primitiveFailure("number", value, context);
    }
    return value;
  },

  boolean(value: unknown, context?: string): boolean {
    if (!enabled) return value as boolean;
    if (typeof value !== "boolean") {
      throw primitiveFailure("boolean", value, context);
    }
    return value;
  },

  uint8Array(value: unknown, context?: string): Uint8Array {
    if (!enabled) return value as Uint8Array;
    if (!(value instanceof Uint8Array)) {
      throw primitiveFailure("Uint8Array", value, context);
    }
    return value;
  },
});

export { assert };
export type { Assert };
