// Behavior tests for the rune assert runtime. No mocks — real class-validator /
// class-transformer, real subprocesses for the env kill-switch.
import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertThrows,
} from "#assert";
import {
  Allow,
  IsArray,
  IsBoolean,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { assert, RuneAssertError } from "./mod.ts";

class TaskDto {
  @IsString()
  id!: string;

  @IsString()
  title!: string;

  @IsBoolean()
  done!: boolean;
}

class OrderLineDto {
  @IsString()
  sku!: string;

  @Min(1)
  qty!: number;
}

class OrderDto {
  @IsUUID()
  id!: string;

  @ValidateNested()
  @Type(() => TaskDto)
  task!: TaskDto;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => OrderLineDto)
  lines!: OrderLineDto[];

  @Allow()
  meta!: unknown;
}

// ---- assert(Cls, plain) -------------------------------------------------------

Deno.test("assert — valid plain object becomes a typed instance", () => {
  const out = assert(TaskDto, { id: "1", title: "write tests", done: false });
  assertInstanceOf(out, TaskDto);
  assertEquals(out.id, "1");
  assertEquals(out.title, "write tests");
  assertEquals(out.done, false);
});

Deno.test("assert — top-level constraint failure throws RuneAssertError with paths", () => {
  const err = assertThrows(
    () => assert(TaskDto, { id: 7, title: "x", done: "nope" }),
    RuneAssertError,
  );
  assertEquals(err.name, "RuneAssertError");
  assertEquals(err.target, "TaskDto");
  const paths = err.failures.map((f) => f.path).sort();
  assertEquals(paths, ["done", "id"]);
  // every failure carries a constraint id and a human message
  for (const f of err.failures) {
    assertEquals(typeof f.constraint, "string");
    assertEquals(f.message.length > 0, true);
  }
});

Deno.test("assert — nested DTO failure is flattened with a dotted path", () => {
  const err = assertThrows(
    () =>
      assert(OrderDto, {
        id: "9b2d6f3a-1d3a-4f9e-8b6a-2f1c5d7e9a0b",
        task: { id: "t1", title: 42, done: true },
        lines: [{ sku: "A", qty: 2 }],
        meta: null,
      }),
    RuneAssertError,
  );
  assertEquals(err.failures.length, 1);
  assertEquals(err.failures[0].path, "task.title");
  // the message names the failing leaf, not an empty string
  assertEquals(err.message.includes("task.title"), true);
});

Deno.test("assert — nested array element failure carries the index in the path", () => {
  const err = assertThrows(
    () =>
      assert(OrderDto, {
        id: "9b2d6f3a-1d3a-4f9e-8b6a-2f1c5d7e9a0b",
        task: { id: "t1", title: "ok", done: true },
        lines: [{ sku: "A", qty: 2 }, { sku: "B", qty: 0 }],
        meta: 1,
      }),
    RuneAssertError,
  );
  assertEquals(err.failures.length, 1);
  assertEquals(err.failures[0].path, "lines.1.qty");
});

Deno.test("assert — extraneous properties are stripped (whitelist), @Allow fields survive", () => {
  const out = assert(OrderDto, {
    id: "9b2d6f3a-1d3a-4f9e-8b6a-2f1c5d7e9a0b",
    task: { id: "t1", title: "ok", done: true },
    lines: [],
    meta: { anything: true },
    rogue: "should not survive",
  });
  assertEquals("rogue" in out, false);
  assertEquals(out.meta, { anything: true });
});

Deno.test("assert — an existing instance is validated in place and returned by reference", () => {
  const t = new TaskDto();
  t.id = "1";
  t.title = "same ref";
  t.done = true;
  const out = assert(TaskDto, t);
  assertStrictEquals(out, t);
});

Deno.test("assert — an invalid existing instance still throws", () => {
  const t = new TaskDto();
  t.id = "1";
  // title left undefined
  t.done = true;
  assertThrows(() => assert(TaskDto, t), RuneAssertError);
});

Deno.test("assert — non-object input throws a single typed failure", () => {
  for (const bad of [null, undefined, 42, "str", [{ id: "1" }]]) {
    const err = assertThrows(() => assert(TaskDto, bad), RuneAssertError);
    assertEquals(err.failures.length, 1);
    assertEquals(err.target, "TaskDto");
  }
});

Deno.test("assert — context label lands in the error and its message", () => {
  const err = assertThrows(
    () => assert(TaskDto, { id: 1 }, "task.load"),
    RuneAssertError,
  );
  assertEquals(err.context, "task.load");
  assertEquals(err.message.includes("task.load"), true);
});

// ---- assert.arrayOf -----------------------------------------------------------

Deno.test("assert.arrayOf — valid array maps every element to an instance", () => {
  const out = assert.arrayOf(TaskDto, [
    { id: "1", title: "a", done: false },
    { id: "2", title: "b", done: true },
  ]);
  assertEquals(out.length, 2);
  for (const t of out) assertInstanceOf(t, TaskDto);
});

Deno.test("assert.arrayOf — element failures aggregate with index paths", () => {
  const err = assertThrows(
    () =>
      assert.arrayOf(TaskDto, [
        { id: "1", title: "ok", done: false },
        { id: 2, title: "bad", done: false },
        { id: "3", title: 3, done: false },
      ]),
    RuneAssertError,
  );
  assertEquals(err.target, "TaskDto[]");
  assertEquals(err.failures.map((f) => f.path).sort(), ["1.id", "2.title"]);
});

Deno.test("assert.arrayOf — non-array input throws", () => {
  const err = assertThrows(
    () => assert.arrayOf(TaskDto, { id: "1" }),
    RuneAssertError,
  );
  assertEquals(err.target, "TaskDto[]");
});

// ---- primitives ---------------------------------------------------------------

Deno.test("assert.string — narrows and returns the same value", () => {
  assertStrictEquals(assert.string("hello"), "hello");
  assertThrows(() => assert.string(5), RuneAssertError);
  assertThrows(() => assert.string(null), RuneAssertError);
});

Deno.test("assert.number — rejects NaN and Infinity, accepts finite numbers", () => {
  assertStrictEquals(assert.number(3.5), 3.5);
  assertStrictEquals(assert.number(0), 0);
  assertThrows(() => assert.number(NaN), RuneAssertError);
  assertThrows(() => assert.number(Infinity), RuneAssertError);
  assertThrows(() => assert.number("5"), RuneAssertError);
});

Deno.test("assert.boolean — accepts only booleans", () => {
  assertStrictEquals(assert.boolean(true), true);
  assertStrictEquals(assert.boolean(false), false);
  assertThrows(() => assert.boolean(0), RuneAssertError);
});

Deno.test("assert.uint8Array — accepts only Uint8Array", () => {
  const buf = new Uint8Array([1, 2, 3]);
  assertStrictEquals(assert.uint8Array(buf), buf);
  assertThrows(() => assert.uint8Array([1, 2, 3]), RuneAssertError);
});

Deno.test("primitives — context label is reported", () => {
  const err = assertThrows(
    () => assert.string(1, "id::generate output"),
    RuneAssertError,
  );
  assertEquals(err.context, "id::generate output");
});

// ---- RuneAssertError shape (the keep 422 contract) ----------------------------

Deno.test("RuneAssertError — duck-typed contract for keep (name + failures array)", () => {
  const err = assertThrows(() => assert(TaskDto, {}), RuneAssertError);
  // keep detects this WITHOUT importing the class: by name + failures shape.
  const duck = err as unknown as Record<string, unknown>;
  assertEquals(duck.name, "RuneAssertError");
  assertEquals(Array.isArray(duck.failures), true);
  assertEquals(typeof duck.target, "string");
  const f = (duck.failures as Record<string, unknown>[])[0];
  assertEquals(typeof f.path, "string");
  assertEquals(typeof f.message, "string");
});

// ---- RUNE_ASSERT=off kill switch (real subprocess: env is read at module load) -

async function runSwitchProbe(env: Record<string, string>): Promise<string> {
  const cmd = new Deno.Command(Deno.execPath(), {
    args: ["run", "--no-prompt", "-A", "switch-probe.ts"],
    cwd: new URL(".", import.meta.url).pathname,
    env,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  const stdout = new TextDecoder().decode(out.stdout).trim();
  const stderr = new TextDecoder().decode(out.stderr).trim();
  if (!out.success) throw new Error(`probe failed: ${stderr}`);
  return stdout;
}

Deno.test("RUNE_ASSERT=off — assert becomes a passthrough", async () => {
  assertEquals(await runSwitchProbe({ RUNE_ASSERT: "off" }), "passthrough");
});

Deno.test("RUNE_ASSERT unset — assert enforces", async () => {
  assertEquals(await runSwitchProbe({}), "enforced");
});

Deno.test("assert — [DTO:open] marker keeps undeclared fields, still validates declared", () => {
  // rune emits `static readonly __keepOpen = true` for a [DTO:open] class. assert reads it and
  // validates with whitelist:false, so an opaque inbound payload's extras ride through intact.
  class OpenEventDto {
    static readonly __keepOpen = true;
    @IsString()
    callId!: string;
  }
  const out = assert(OpenEventDto, {
    callId: "c1",
    extra: 1,
    nested: { a: true },
  }) as unknown as Record<string, unknown>;
  assertEquals(out.callId, "c1");
  assertEquals(out.extra, 1, "undeclared scalar must survive (open)");
  assertEquals(
    out.nested,
    { a: true },
    "undeclared object must survive (open)",
  );

  // The declared field is still validated — a bad value 422s even on an open DTO.
  assertThrows(
    () => assert(OpenEventDto, { callId: 123 }),
    RuneAssertError,
  );

  // Without the marker, the same extras are stripped (today's strict default).
  class StrictEventDto {
    @IsString()
    callId!: string;
  }
  const strict = assert(StrictEventDto, {
    callId: "c1",
    extra: 1,
  }) as unknown as Record<
    string,
    unknown
  >;
  assertEquals("extra" in strict, false, "strict DTO strips undeclared fields");
});

Deno.test("assert — [DTO:open] re-attaches extras even when they shadow a prototype member (own-property check)", () => {
  // The re-attach loop must use an OWN-property check, not the prototype-aware `in`. An inbound
  // field named like an Object.prototype member ("toString", "constructor", "hasOwnProperty") is a
  // legitimate extra and must ride through as the instance's OWN value — `in` would see the
  // inherited prototype member and silently drop the inbound value.
  class OpenShadowDto {
    static readonly __keepOpen = true;
    @IsString()
    id!: string;
  }
  // Read via a bag indexer so TS doesn't resolve the prototype member signatures.
  const out = assert(OpenShadowDto, {
    id: "x",
    extra: "kept",
    toString: "v",
    constructor: "c",
    hasOwnProperty: "h",
  }) as unknown;
  const bag = out as Record<string, unknown>;
  assertEquals(bag["id"], "x");
  assertEquals(bag["extra"], "kept", "a plain extra still rides through");
  // Each prototype-shadowing field must be re-attached as an OWN property with the inbound value.
  assertEquals(
    Object.prototype.hasOwnProperty.call(out, "toString"),
    true,
    "inbound `toString` re-attaches as an own property",
  );
  assertEquals(bag["toString"], "v");
  assertEquals(
    Object.prototype.hasOwnProperty.call(out, "constructor"),
    true,
    "inbound `constructor` re-attaches as an own property",
  );
  assertEquals(bag["constructor"], "c");
  assertEquals(
    Object.prototype.hasOwnProperty.call(out, "hasOwnProperty"),
    true,
    "inbound `hasOwnProperty` re-attaches as an own property",
  );
  assertEquals(bag["hasOwnProperty"], "h");
});

Deno.test("assert — [DTO:open] re-attaches its own extras but a declared nested DTO keeps its strict contract", () => {
  class InnerDto {
    @IsString()
    name!: string;
  }
  class OpenOuterDto {
    static readonly __keepOpen = true;
    @IsString()
    id!: string;
    @ValidateNested()
    @Type(() => InnerDto)
    inner!: InnerDto;
  }
  const out = assert(OpenOuterDto, {
    id: "x",
    extraTop: "ride", // the open DTO's own undeclared field → survives
    inner: { name: "n", secret: "strip" }, // a declared strict nested DTO → its extra is stripped
  }) as unknown as Record<string, unknown>;
  assertEquals(out.id, "x");
  assertEquals(
    out.extraTop,
    "ride",
    "the open DTO's own undeclared field rides through",
  );
  // out.inner is an InnerDto instance; compare its own props structurally. `secret` must be gone.
  assertEquals(
    { ...(out.inner as object) },
    { name: "n" },
    "a declared nested DTO keeps its own strict contract — its extra field is stripped",
  );
});
