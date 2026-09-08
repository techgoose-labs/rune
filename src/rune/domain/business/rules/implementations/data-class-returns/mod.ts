import type { EntryTarget, PipelineContext } from "@core/dto/types.ts";

const SOURCE_EXTS = new Set(["ts", "tsx"]);
const DECORATOR_RE = /@Is[A-Z]\w*\(|@Valid\w*\(/;
const PRIMITIVE_RETURNS = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "null",
  "undefined",
  "any",
  "unknown",
  "object",
]);

function unwrapPromise(t: string): string {
  const m = t.match(/^Promise<([\s\S]+)>$/);
  return m ? m[1].trim() : t;
}

function isOkReturn(t: string): boolean {
  const s = unwrapPromise(t.trim());
  if (s === "void" || s === "this") return true;
  if (PRIMITIVE_RETURNS.has(s)) return false;
  if (s.startsWith("{")) return false;
  if (/^["'`]/.test(s)) return false;
  const first = s.replace(/<.*$/, "");
  return /^[A-Z]\w*$/.test(first);
}

// Split class members on `;`, but only at top-level brace/paren/bracket depth, so
// an inline object type in a return or param (e.g. `m(): { a: number; b: string }`)
// isn't fragmented at its internal `;`.
function splitMembers(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = "";
  for (const ch of inner) {
    if (ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth = Math.max(0, depth - 1);
    }
    if (ch === ";" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (buf.trim()) parts.push(buf);
  return parts;
}

function extractMethodReturns(
  sig: string,
): Array<{ name: string; ret: string }> {
  const out: Array<{ name: string; ret: string }> = [];
  const body = sig.match(/\{([\s\S]*)\}\s*$/);
  if (!body) return out;
  const inner = body[1];
  // Members are `;`-separated; the LSP may return them on one line or many, so
  // split on `;` itself rather than requiring a trailing newline.
  const lines = splitMembers(inner);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(
      /^(?:public |private |protected |static |readonly |async )*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\(([\s\S]*?)\)\s*:\s*([\s\S]+)$/,
    );
    if (!m) continue;
    out.push({ name: m[1], ret: m[3].trim() });
  }
  return out;
}

export async function check(
  path: string,
  target: EntryTarget,
  ctx: PipelineContext,
): Promise<string[] | null> {
  if (target === "folder" || !SOURCE_EXTS.has(target as string)) return null;
  if (/\.(?:test|spec)\./.test(path)) return null;
  if (!ctx.lsp) return null;

  const content = await ctx.getFileContent(path);
  if (!DECORATOR_RE.test(content)) return null;

  let exports;
  try {
    exports = await ctx.lsp.getExportTypes(path);
  } catch {
    return null;
  }
  const classes = exports.filter((e) => e.kind === "Class");
  if (classes.length === 0) return null;

  const violations: string[] = [];
  for (const cls of classes) {
    const sig = await ctx.lsp.getSymbolType(path, cls.name);
    if (!sig) continue;
    const methods = extractMethodReturns(sig);
    for (const { name, ret } of methods) {
      if (name === "constructor") continue;
      if (!isOkReturn(ret)) {
        violations.push(
          `${cls.name}.${name}() returns "${ret}" — data class methods must return a validated class instance (e.g. assert(T, ...) or plainToInstance(T, ...))`,
        );
      }
    }
  }

  return violations.length ? violations : null;
}

export const SYSTEM_PROMPT =
  `You are a code architecture advisor enforcing data class return-type discipline.

Rule: Methods on data classes (classes decorated with class-validator @Is*/@Valid* decorators) must return validated class instances — produced via \`assert(T, x)\`, \`plainToInstance(T, x)\`, or \`new T(...)\`. Returning plain object literals, primitives, or untyped values bypasses runtime validation.

Be concise (2-3 sentences).`;

export function buildPrompt(
  violations: string[],
  path: string,
  _target: EntryTarget,
): string {
  return `File: ${path}
Violations:
${violations.map((v) => "  - " + v).join("\n")}

Each flagged method should wrap its return value in \`assert(Cls, ...)\` or \`plainToInstance(Cls, ...)\` so the output is a validated instance. What should the developer change?`;
}
