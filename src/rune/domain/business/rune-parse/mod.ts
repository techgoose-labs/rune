// Rune line-based parser. Pure function: text → structured AST.
// Mirrors rune/parser/src/lib.rs but produces a tree instead of a flat line list.

import {
  parseTypModifiers,
  TYP_MODIFIERS,
} from "@rune/domain/business/rune-modifiers/mod.ts";

// The closed set of service transports a [SRV] may declare, written as a
// parenthesized prefix: `[SRV] (SDK)stripe: KEY`. NATIVE is the in-process
// runtime/std-lib boundary (filesystem, subprocess, crypto, clock) — neither a
// network surface nor a co-located process; its faults are synchronous throws.
export const SRV_TRANSPORTS = [
  "SDK",
  "HTTP",
  "WEBSOCKET",
  "SIDECAR",
  "NATIVE",
] as const;
export type SrvTransport = typeof SRV_TRANSPORTS[number];

// A [MOD] name becomes a `src/<module>/` directory AND is camel/pascal-cased
// into a JS identifier alias in the generated bootstrap registry. Constrain it
// to the same identifier shape [SRV] names use — a letter/underscore start, then
// letters, digits, `-`, `_` — so a digit-leading or punctuated name can't slip
// through and emit a registry that won't parse or type-check.
export const MOD_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export interface RuneAst {
  module: string | null;
  /** Optional [MOD] description (`[MOD] name: prose…` + indented continuation). */
  moduleDescription: string | null;
  reqs: ReqNode[];
  ents: EntNode[];
  dtos: DtoNode[];
  typs: TypNode[];
  nons: NonNode[];
  /** Declared backing services ([SRV] <transport>:<name>: <ENV,…>). */
  srvs: SrvNode[];
  errors: ParseError[];
}

export interface ReqNode {
  noun: string;
  verb: string;
  input: string;
  output: string;
  steps: StepLike[];
  /** `[REQ:open]` — the openness marker. True ⇒ this endpoint is reachable
   *  without a credential, and codegen stamps `x-bedrock-auth` on it. */
  isOpen: boolean;
  line: number;
}

export interface EntNode {
  surface: string;
  action: string;
  input: string;
  output: string;
  /**
   * The bracket modifier, e.g. `[ENT:card]` → "card". Codegen reads it as the endpoint's
   * process flow (a named branch); the reserved modifier `optional` marks a step the
   * emulator/runner attempt but don't require. Null for plain `[ENT]`.
   */
  modifier: string | null;
  line: number;
  /**
   * Explicit HTTP verb from an `[ENT] … @ POST /…` clause (lowercased). Null ⇒ POST (the default).
   */
  method?: string | null;
  /**
   * Explicit route template from `@ METHOD <template>` with `{name}` / `{name*}` segments
   * (e.g. `/proxy/{target}/{path*}`). Null ⇒ the route is auto-derived from the action + the
   * field sources. A `{name}` segment binds that field from the path, `{name*}` is the catch-all.
   */
  pathTemplate?: string | null;
  /**
   * Transport kind. "http" (the default, and the value when omitted) is a request/response
   * route. "ws" is a WebSocket message handler grouped under an `[ENT:ws]` socket header:
   * `action` is the message topic, `pathTemplate` is the handshake path shared by every
   * topic on the socket, and `method` is null (the upgrade is always a GET).
   */
  kind?: "http" | "ws";
  /**
   * The [REQ] this ent dispatches to, captured from an indented `[REQ]` line in the ent body
   * (`[ENT] http.x(A): B` then `    [REQ] noun.verb(A): B`). When set, codegen delegates to exactly
   * this coordinator instead of guessing by the (input, output) signature.
   */
  delegate?: { noun: string; verb: string };
}

export type StepLike =
  | StepNode
  | BoundaryStepNode
  | PlyNode
  | CtrNode
  | RetNode;

export interface StepNode {
  kind: "step";
  noun: string;
  verb: string;
  params: string[];
  output: string;
  isStatic: boolean;
  faults: string[];
  line: number;
}

export interface BoundaryStepNode {
  kind: "boundary";
  /** The backing service name (the `<service>:` prefix); resolved to a [SRV]
   * by the rune-service-presence lint rule, not at parse time. */
  service: string;
  noun: string;
  verb: string;
  params: string[];
  output: string;
  isStatic: boolean;
  faults: string[];
  line: number;
}

export interface PlyNode {
  kind: "ply";
  noun: string;
  verb: string;
  params: string[];
  output: string;
  isStatic: boolean;
  cases: CseNode[];
  line: number;
}

export interface CseNode {
  name: string;
  steps: Array<StepNode | BoundaryStepNode | CtrNode | RetNode>;
  line: number;
}

export interface CtrNode {
  kind: "ctr";
  className: string;
  line: number;
}

export interface RetNode {
  kind: "ret";
  value: string;
  line: number;
}

export interface DtoNode {
  name: string;
  properties: string[];
  description: string;
  isCore: boolean;
  /** [DTO:open] — opaque inbound payload: declared fields are validated, undeclared
   * fields pass through (the generated class carries a marker keep's assert reads). */
  isOpen: boolean;
  line: number;
}

export interface TypNode {
  name: string;
  typeName: string;
  description: string;
  isCore: boolean;
  /**
   * `[TYP:ext]` — the value is produced OUTSIDE this module (another module's endpoint, a
   * human). Entrypoint codegen turns unproduced input fields of this type into `$name`
   * external-input binds instead of leaving them unwired.
   */
  isExternal: boolean;
  /**
   * Raw bracket modifiers in source order, e.g. `[TYP:ext,uuid]` →
   * ["ext", "uuid"], `[TYP:min=0,max=100]` → ["min=0", "max=100"]. Includes
   * ext/core; constraint modifiers map to class-validator decorators via
   * TYP_MODIFIERS (rune-modifiers). Invalid items are dropped (and reported
   * in ast.errors).
   */
  modifiers: string[];
  line: number;
}

export interface NonNode {
  name: string;
  description: string;
  line: number;
}

export interface SrvNode {
  /** Transport — one of SRV_TRANSPORTS (SDK/HTTP/WEBSOCKET/SIDECAR/NATIVE).
   * NATIVE is in-process (no connection); the rest front a network/SDK/process. */
  transport: string;
  /** Service name referenced by `<name>:` boundary prefixes. */
  name: string;
  /** Declared environment variable names (comma-separated after the 2nd colon). */
  envVars: string[];
  description: string;
  /** REQUIRED documentation link — the indented `@docs <url>` line under the
   * [SRV]. A spec with a [SRV] missing this is a hard parse error (surfaced by
   * `rune check` and mirrored by the LSP). Empty only on a malformed spec. */
  docsLink: string;
  line: number;
}

export interface ParseError {
  line: number;
  message: string;
}

export function parse(text: string, opts: ParseOptions = {}): RuneAst {
  const rec = new TagRecognizer(opts.tags ?? BUILTIN_TAGS);
  const ast: RuneAst = {
    module: null,
    moduleDescription: null,
    reqs: [],
    ents: [],
    dtos: [],
    typs: [],
    nons: [],
    srvs: [],
    errors: [],
  };

  const lines = text.split(/\r?\n/);

  // Block-mode tracking for indented description lines. Any node with a
  // `description` field can be the target (DTO/TYP/NON/SRV + the module).
  let descTarget: { description: string } | null = null;
  // The module's description accumulates here ([MOD] name: prose + continuation);
  // flushed onto ast.moduleDescription after the walk.
  const modDesc = { description: "" };

  // Tree-builder state.
  let currentReq: ReqNode | null = null;
  let currentPly: PlyNode | null = null;
  let currentCse: CseNode | null = null;
  let lastStep: StepNode | BoundaryStepNode | null = null;
  let currentEnt: EntNode | null = null;
  // An open `[ENT:ws]` socket. While set, subsequent indented `verb(InputDto): OutputDto`
  // lines are its topics — each becomes a kind:"ws" EntNode sharing this handshake path.
  // Closed by any dedent to column 0 (the next top-level tag) or end-of-file.
  let currentWsSocket:
    | {
      surface: string;
      pathTemplate: string | null;
      line: number;
      topicCount: number;
    }
    | null = null;
  // The [SRV] whose description block is currently open — routes an indented
  // `@docs <url>` line to its docsLink. Only "active" while descTarget === it.
  let currentSrv: SrvNode | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const indent = countIndent(raw);

    // Pure comment lines: ignore (no AST node, but don't reset blocks).
    const trimmed0 = raw.trim();
    if (trimmed0.startsWith("//")) continue;

    // Strip inline comment.
    const noComment = stripInlineComment(raw);
    const trimmed = noComment.trim();

    if (trimmed === "") {
      // Blank line ends description blocks and current REQ scope for steps.
      descTarget = null;
      continue;
    }

    // An indented [REQ] directly under an [ENT] is that ENT's delegation target (the documented
    // ent-body form) — capture it instead of letting it become a stepless shadow coordinator.
    // Any other line ends the ent-body context.
    if (currentEnt) {
      const entReq = indent > 0 ? rec.match(trimmed, "req") : null;
      if (entReq) {
        const sig = parseReqSignature(entReq.rest);
        if (!sig) {
          ast.errors.push({
            line: i,
            message: "[ENT] body [REQ] has a malformed signature",
          });
        } else if (entReq.modifier !== null) {
          ast.errors.push({
            line: i,
            message: "[ENT] body [REQ] does not take a modifier",
          });
        } else {
          currentEnt.delegate = { noun: sig.noun, verb: sig.verb };
        }
        currentEnt = null;
        descTarget = null;
        continue;
      }
      currentEnt = null;
    }

    // Topics of an open [ENT:ws] socket. Each indented `verb(InputDto): OutputDto` line
    // becomes a kind:"ws" EntNode sharing the socket's handshake path (action = the topic).
    // A dedent to column 0 closes the socket and falls through to normal top-level parsing;
    // blank lines (handled above) keep it open so topics may be visually grouped.
    if (currentWsSocket) {
      if (indent > 0) {
        const topic = parseWsTopicSignature(trimmed);
        if (topic) {
          ast.ents.push({
            surface: currentWsSocket.surface,
            action: topic.verb,
            input: topic.input,
            output: topic.output,
            modifier: null,
            line: i,
            method: null,
            pathTemplate: currentWsSocket.pathTemplate,
            kind: "ws",
          });
          currentWsSocket.topicCount++;
        } else {
          ast.errors.push({
            line: i,
            message:
              `[ENT:ws] ${currentWsSocket.surface}: malformed topic — expected "<verb>(InputDto): OutputDto"`,
          });
        }
        descTarget = null;
        continue;
      }
      if (currentWsSocket.topicCount === 0) {
        ast.errors.push({
          line: currentWsSocket.line,
          message:
            `[ENT:ws] ${currentWsSocket.surface} has no topics — add at least one "<verb>(InputDto): OutputDto"`,
        });
      }
      currentWsSocket = null;
    }

    // Close [PLY]/[CSE] block when indentation drops back to step level (≤4)
    // and the current line is not a [CSE] (which lives at indent 8 inside PLY).
    // Faults sit at indent ≥6 so they don't trigger this.
    if (
      currentPly &&
      indent <= 4 &&
      !rec.is(trimmed, "cse") &&
      !(indent >= 6 && trimmed.split(/\s+/).every(isFaultName))
    ) {
      currentPly = null;
      currentCse = null;
    }

    // [MOD] directive — must come before any element, but we accept it anywhere.
    // `[MOD] name` or `[MOD] name: prose…`; the prose continues on indented lines.
    const modTag = rec.match(trimmed, "mod");
    if (modTag) {
      const rest = modTag.rest;
      const colon = rest.indexOf(":");
      const name = (colon === -1 ? rest : rest.slice(0, colon)).trim();
      const inlineDesc = colon === -1 ? "" : rest.slice(colon + 1).trim();
      if (name === "") {
        ast.errors.push({ line: i, message: "[MOD] missing name" });
        descTarget = null;
      } else if (!MOD_NAME_RE.test(name)) {
        ast.errors.push({
          line: i,
          message:
            `[MOD] invalid name "${name}" — must start with a letter or "_" and use only letters, digits, "-", "_"`,
        });
        descTarget = null;
      } else if (ast.module !== null) {
        ast.errors.push({
          line: i,
          message: `duplicate [MOD]: already set to "${ast.module}"`,
        });
        descTarget = null;
      } else {
        ast.module = name;
        if (inlineDesc) modDesc.description = inlineDesc;
        descTarget = modDesc; // indented continuation appends to the module desc
      }
      continue;
    }

    // [SRV] (TRANSPORT)<name>: <ENV, ENV2>  (the backing-service declaration).
    if (trimmed.startsWith("[SRV]")) {
      const rest = trimmed.slice("[SRV]".length).trim();
      const m = rest.match(
        /^\(([A-Za-z]+)\)([A-Za-z_][A-Za-z0-9_-]*)(?::\s*(.*))?$/,
      );
      if (!m) {
        ast.errors.push({
          line: i,
          message:
            "[SRV] malformed — expected [SRV] (TRANSPORT)<name>: <ENV,…>",
        });
        descTarget = null;
        continue;
      }
      const [, transport, name, envStr] = m;
      if (!SRV_TRANSPORTS.includes(transport as SrvTransport)) {
        ast.errors.push({
          line: i,
          message: `[SRV] unknown transport "${transport}" — expected ${
            SRV_TRANSPORTS.join("/")
          }`,
        });
      }
      const envVars = (envStr ?? "").split(",").map((s) => s.trim()).filter((
        s,
      ) => s !== "");
      const node: SrvNode = {
        transport,
        name,
        envVars,
        description: "",
        docsLink: "",
        line: i,
      };
      ast.srvs.push(node);
      descTarget = node;
      currentSrv = node; // indented `@docs <url>` routes to node.docsLink
      continue;
    }

    // [REQ] — takes exactly ONE modifier, `:open`, the OPENNESS MARKER. It
    // declares that the endpoint is reachable without a credential; codegen
    // emits it as `x-bedrock-auth: { access: "open" }` on the operation, and
    // the backend derives its policy table from that. Unmarked means
    // authenticated — the slot default. Openness is now something the spec
    // STATES, in the same file as the endpoint, instead of a decorator
    // hand-re-applied to generated controllers after every regeneration.
    const reqTag = rec.match(trimmed, "req");
    if (reqTag) {
      const isOpen = reqTag.modifier === "open";
      if (reqTag.modifier === "core") {
        ast.errors.push({
          line: i,
          message: "[REQ:core] is invalid — coordinators are module-level",
        });
      } else if (reqTag.modifier !== null && !isOpen) {
        ast.errors.push({
          line: i,
          message:
            `[REQ] unknown modifier "${reqTag.modifier}" — the only one is :open`,
        });
      }
      const sig = parseReqSignature(reqTag.rest);
      if (!sig) {
        ast.errors.push({
          line: i,
          message: "[REQ] missing or malformed signature",
        });
        currentReq = null;
      } else {
        currentReq = { ...sig, steps: [], isOpen, line: i };
        ast.reqs.push(currentReq);
      }
      currentPly = null;
      currentCse = null;
      lastStep = null;
      descTarget = null;
      continue;
    }

    // [ENT] — same shape as REQ
    const entTag = rec.match(trimmed, "ent");
    if (entTag) {
      // [ENT:ws] opens a WebSocket socket: `[ENT:ws] <surface> @ /path`. The indented
      // `verb(InputDto): OutputDto` lines that follow are its topics (consumed above on
      // the next iterations). The header itself emits no EntNode — only its topics do.
      if (entTag.modifier === "ws") {
        const header = parseWsHeader(entTag.rest);
        if (!header) {
          ast.errors.push({
            line: i,
            message:
              '[ENT:ws] malformed — expected "[ENT:ws] <surface> @ /path"',
          });
          currentWsSocket = null;
        } else {
          currentWsSocket = {
            surface: header.surface,
            pathTemplate: header.pathTemplate,
            line: i,
            topicCount: 0,
          };
        }
        currentReq = null;
        currentPly = null;
        currentCse = null;
        lastStep = null;
        currentEnt = null;
        descTarget = null;
        continue;
      }
      const sig = parseReqSignature(entTag.rest);
      if (!sig) {
        ast.errors.push({
          line: i,
          message: "[ENT] missing or malformed signature",
        });
      } else {
        // An explicit `@ METHOD` must name a real HTTP verb.
        if (sig.method && !ENT_METHODS.has(sig.method)) {
          ast.errors.push({
            line: i,
            message:
              `[ENT] HTTP method must be one of GET, POST, PUT, PATCH, DELETE (got "${sig.method.toUpperCase()}")`,
          });
        }
        const entNode: EntNode = {
          surface: sig.noun,
          action: sig.verb,
          input: sig.input,
          output: sig.output,
          modifier: entTag.modifier,
          line: i,
          method: sig.method ?? null,
          pathTemplate: sig.pathTemplate ?? null,
        };
        ast.ents.push(entNode);
        currentEnt = entNode; // an indented [REQ] on the next line becomes its delegate
      }
      currentReq = null;
      currentPly = null;
      currentCse = null;
      lastStep = null;
      descTarget = null;
      continue;
    }

    // [DTO] / [DTO:core]
    const dtoTag = rec.match(trimmed, "dto");
    if (dtoTag) {
      const isCore = dtoTag.modifier === "core";
      // [DTO:open] — opaque inbound payload: validate the declared fields but let undeclared
      // ones ride through (keep's assert reads the generated marker and re-attaches them).
      const isOpen = dtoTag.modifier === "open";
      // A modifier that is neither :core nor :open is a typo (e.g. [DTO:opne]) — error loudly
      // rather than silently degrading to a strict DTO that would strip an inbound payload's
      // fields at runtime with no warning. Mirrors the [REQ] modifier guard.
      if (dtoTag.modifier && !isCore && !isOpen) {
        ast.errors.push({
          line: i,
          message:
            `[DTO] unknown modifier "${dtoTag.modifier}" — expected :core or :open`,
        });
      }
      const colon = dtoTag.rest.indexOf(":");
      if (colon === -1) {
        ast.errors.push({ line: i, message: "[DTO] missing properties" });
      } else {
        const name = dtoTag.rest.slice(0, colon).trim();
        const props = dtoTag.rest
          .slice(colon + 1)
          .split(",")
          .map((p) => p.trim())
          .filter((p) => p.length > 0);
        const node: DtoNode = {
          name,
          properties: props,
          description: "",
          isCore,
          isOpen,
          line: i,
        };
        ast.dtos.push(node);
        descTarget = node;
      }
      currentReq = null;
      currentPly = null;
      currentCse = null;
      lastStep = null;
      continue;
    }

    // [TYP] — the bracket slot is a comma-separated modifier list:
    // [TYP:core], [TYP:ext,uuid], [TYP:min=0,max=100]. ext/core compose with
    // the constraint modifiers; validation messages mirror the LSP byte-for-byte.
    const typTag = rec.match(trimmed, "typ");
    if (typTag) {
      const { mods, errors: modErrors } = parseTypModifiers(typTag.modifier);
      for (const message of modErrors) ast.errors.push({ line: i, message });
      const colon = typTag.rest.indexOf(":");
      if (colon === -1) {
        ast.errors.push({ line: i, message: "[TYP] missing type" });
      } else {
        const name = typTag.rest.slice(0, colon).trim();
        const typeName = typTag.rest.slice(colon + 1).trim();
        // Base-type applicability: a constraint only fits its base primitive
        // (e.g. uuid → string). The parser knows the declared type, so the
        // check lives here, not in parseTypModifiers.
        for (const mod of mods) {
          const id = mod.split("=")[0];
          const spec = TYP_MODIFIERS.get(id);
          if (spec?.base && spec.base !== typeName) {
            ast.errors.push({
              line: i,
              message:
                `[TYP] modifier "${id}" requires a ${spec.base} type, but "${name}" is ${typeName}`,
            });
          }
        }
        const node: TypNode = {
          name,
          typeName,
          description: "",
          isCore: mods.includes("core"),
          isExternal: mods.includes("ext"),
          modifiers: mods,
          line: i,
        };
        ast.typs.push(node);
        descTarget = node;
      }
      currentReq = null;
      currentPly = null;
      currentCse = null;
      lastStep = null;
      continue;
    }

    // [NON]
    const nonTag = rec.match(trimmed, "non");
    if (nonTag) {
      const name = nonTag.rest.trim();
      if (name === "") {
        ast.errors.push({ line: i, message: "[NON] missing name" });
      } else {
        const node: NonNode = { name, description: "", line: i };
        ast.nons.push(node);
        descTarget = node;
      }
      currentReq = null;
      currentPly = null;
      currentCse = null;
      lastStep = null;
      continue;
    }

    // [PLY]
    const plyTag = rec.match(trimmed, "ply");
    if (plyTag) {
      const sig = parseStepSignature(plyTag.rest);
      if (!sig) {
        ast.errors.push({
          line: i,
          message: "[PLY] missing or malformed signature",
        });
      } else {
        const node: PlyNode = { kind: "ply", ...sig, cases: [], line: i };
        if (currentReq) currentReq.steps.push(node);
        else ast.errors.push({ line: i, message: "[PLY] outside [REQ]" });
        currentPly = node;
        currentCse = null;
      }
      lastStep = null;
      descTarget = null;
      continue;
    }

    // [CSE]
    const cseTag = rec.match(trimmed, "cse");
    if (cseTag) {
      const name = cseTag.rest;
      if (name === "") {
        ast.errors.push({ line: i, message: "[CSE] missing case name" });
      } else if (!currentPly) {
        ast.errors.push({ line: i, message: "[CSE] outside [PLY] block" });
      } else {
        const node: CseNode = { name, steps: [], line: i };
        currentPly.cases.push(node);
        currentCse = node;
      }
      lastStep = null;
      descTarget = null;
      continue;
    }

    // [CTR] / [NEW] (synonyms — literals come from the artifact)
    const newTag = rec.match(trimmed, "new");
    if (newTag) {
      const className = newTag.rest;
      if (className === "") {
        ast.errors.push({ line: i, message: "[CTR] missing class name" });
      } else {
        const node: CtrNode = { kind: "ctr", className, line: i };
        appendStepToCurrentScope(
          node,
          currentReq,
          currentPly,
          currentCse,
          ast,
          i,
        );
      }
      lastStep = null;
      descTarget = null;
      continue;
    }

    // [RET]
    const retTag = rec.match(trimmed, "ret");
    if (retTag) {
      const value = retTag.rest;
      if (value === "") {
        ast.errors.push({ line: i, message: "[RET] missing value" });
      } else {
        const node: RetNode = { kind: "ret", value, line: i };
        appendStepToCurrentScope(
          node,
          currentReq,
          currentPly,
          currentCse,
          ast,
          i,
        );
      }
      lastStep = null;
      descTarget = null;
      continue;
    }

    // Boundary step: db:noun.verb(...) or os:Noun::verb(...)
    const boundary = matchBoundary(trimmed);
    if (boundary) {
      const sig = parseStepSignature(boundary.rest);
      if (!sig) {
        ast.errors.push({
          line: i,
          message: `${boundary.service}: malformed signature`,
        });
      } else {
        const node: BoundaryStepNode = {
          kind: "boundary",
          service: boundary.service,
          ...sig,
          faults: [],
          line: i,
        };
        appendStepToCurrentScope(
          node,
          currentReq,
          currentPly,
          currentCse,
          ast,
          i,
        );
        lastStep = node;
      }
      descTarget = null;
      continue;
    }

    // Fault line — at indent ≥ 6, all whitespace-separated tokens are fault names.
    if (indent >= 6 && lastStep) {
      const parts = trimmed.split(/\s+/);
      if (parts.every(isFaultName)) {
        lastStep.faults.push(...parts);
        continue;
      }
    }

    // `@docs <url>` under an [SRV] is the REQUIRED documentation link — routed to
    // docsLink, NOT appended to the prose description. Gated on descTarget still
    // pointing at the current [SRV] so an `@docs`-looking line under a [DTO]/[TYP]
    // stays plain prose (those tags don't carry a docs link).
    if (
      currentSrv && descTarget === currentSrv && indent === 4 &&
      (trimmed === "@docs" || trimmed.startsWith("@docs "))
    ) {
      const url = trimmed.slice("@docs".length).trim();
      if (url === "") {
        ast.errors.push({
          line: i,
          message: `[SRV] ${currentSrv.name}: @docs needs a URL`,
        });
      } else if (currentSrv.docsLink) {
        ast.errors.push({
          line: i,
          message: `[SRV] ${currentSrv.name}: duplicate @docs link`,
        });
      } else {
        currentSrv.docsLink = url;
      }
      continue;
    }

    // Description line: free-text prose at 4-space indent under [DTO]/[TYP]/[NON].
    // `descTarget` is only set by those declarations and is cleared by every step/
    // tag, so an indented line here is unambiguously prose. NOTE: the line has
    // already had any inline `// ...` comment stripped at the top of this loop
    // (stripInlineComment) — `//` is a comment everywhere per spec.md, prose
    // included, so it is NOT preserved verbatim. Apart from that the prose accepts
    // any characters (periods in "e.g.", "@" in emails, parentheticals). Only a
    // nested tag (`[`) ends the block.
    if (descTarget && indent === 4 && !trimmed.startsWith("[")) {
      descTarget.description = descTarget.description
        ? `${descTarget.description} ${trimmed}`
        : trimmed;
      continue;
    }

    // Plain step: noun.verb(...) or Noun::verb(...)
    if (
      (trimmed.includes(".") || trimmed.includes("::")) && trimmed.includes("(")
    ) {
      const sig = parseStepSignature(trimmed);
      if (sig) {
        const node: StepNode = { kind: "step", ...sig, faults: [], line: i };
        appendStepToCurrentScope(
          node,
          currentReq,
          currentPly,
          currentCse,
          ast,
          i,
        );
        lastStep = node;
        descTarget = null;
        continue;
      }
    }

    // Fall-through: unrecognized line.
    ast.errors.push({ line: i, message: `unrecognized line: "${trimmed}"` });
  }

  // An [ENT:ws] socket still open at EOF with no topics is an error (mirrors the
  // dedent-close check inside the loop, for a socket that ends the file).
  if (currentWsSocket && currentWsSocket.topicCount === 0) {
    ast.errors.push({
      line: currentWsSocket.line,
      message:
        `[ENT:ws] ${currentWsSocket.surface} has no topics — add at least one "<verb>(InputDto): OutputDto"`,
    });
  }

  // Every property used in a [DTO] must resolve to a declared type — no untyped
  // (`unknown`) fields. It may be a [TYP], a nested [DTO] (named directly or via
  // the <Name>Dto convention), after stripping the optional `?` and plural `(s)`/`(s?)`
  // modifiers. (TYP names cover both module and :core typs.)
  const typNames = new Set(ast.typs.map((t) => t.name));
  const dtoNames = new Set(ast.dtos.map((d) => d.name));
  const pascal = (s: string) =>
    s.split(/[-_]/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1))
      .join("");
  for (const dto of ast.dtos) {
    for (const prop of dto.properties) {
      const clean = prop.replace(/\(s\??\)/g, "").replace(/\?/g, "").trim();
      const resolved = typNames.has(clean) || dtoNames.has(clean) ||
        dtoNames.has(`${pascal(clean)}Dto`);
      if (!resolved) {
        ast.errors.push({
          line: dto.line,
          message:
            `[DTO] ${dto.name}: property "${prop}" has no [TYP] or [DTO] — declare "[TYP] ${clean}: <type>"`,
        });
      }
    }
  }

  // Every [SRV] MUST declare an `@docs <url>` link (hard error, mirrored by the
  // LSP). It's the one piece of provenance a dev needs to wire the service.
  for (const srv of ast.srvs) {
    if (!srv.docsLink) {
      ast.errors.push({
        line: srv.line,
        message: `[SRV] ${srv.name} requires an @docs <url> line`,
      });
    }
  }

  ast.moduleDescription = modDesc.description.trim() || null;
  return ast;
}

// ---- helpers ----

function countIndent(raw: string): number {
  let n = 0;
  for (const ch of raw) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

function stripInlineComment(raw: string): string {
  // A `//` only starts a comment when it follows whitespace or opens the line —
  // the conventional ` // note` form. A `//` glued to a non-space char is left
  // intact so URLs survive (`@docs https://x` / a URL in a prose description);
  // `://` is never a comment.
  let i = raw.indexOf("//");
  while (i !== -1) {
    const prev = raw[i - 1];
    if (i === 0 || prev === " " || prev === "\t") return raw.slice(0, i);
    i = raw.indexOf("//", i + 2);
  }
  return raw;
}

interface TagMatch {
  modifier: string | null;
  rest: string;
}

function matchTag(trimmed: string, tag: string): TagMatch | null {
  // Match [TAG] or [TAG:modifier]
  if (trimmed.startsWith(`[${tag}]`)) {
    return { modifier: null, rest: trimmed.slice(tag.length + 2).trim() };
  }
  const prefix = `[${tag}:`;
  if (trimmed.startsWith(prefix)) {
    const close = trimmed.indexOf("]");
    if (close > prefix.length) {
      const modifier = trimmed.slice(prefix.length, close).trim();
      const rest = trimmed.slice(close + 1).trim();
      return { modifier, rest };
    }
  }
  return null;
}

// ---- artifact-driven tag recognition (WO-4c) ----
//
// Which literals the parser recognises as tags (and their synonyms) comes from
// the artifact's `language.tags` when supplied (parse(text, { tags })), else
// this built-in table that reproduces the hand-parser exactly so the parse
// goldens / L2 hold. The per-construct STRUCTURAL behaviour stays in the
// dispatch below, keyed by tag id; only recognition is data-driven here.
// Adding a synonym/literal in the artifact changes what the engine parses with
// no parser edit.
export interface ParseTagSpec {
  id: string;
  tag: string;
  synonyms?: string[];
}

export interface ParseOptions {
  tags?: ParseTagSpec[];
}

const BUILTIN_TAGS: ParseTagSpec[] = [
  { id: "mod", tag: "[MOD]" },
  { id: "req", tag: "[REQ]" },
  { id: "ent", tag: "[ENT]" },
  { id: "dto", tag: "[DTO]" },
  { id: "typ", tag: "[TYP]" },
  { id: "non", tag: "[NON]" },
  { id: "ply", tag: "[PLY]" },
  { id: "cse", tag: "[CSE]" },
  { id: "new", tag: "[NEW]", synonyms: ["[CTR]"] },
  { id: "ret", tag: "[RET]" },
];

// Constructs that accept a `[TAG:modifier]` form (the ones the hand-parser ran
// through matchTag). The rest must match their literal exactly.
const MODIFIER_AWARE = new Set(["req", "ent", "dto", "typ", "non"]);

class TagRecognizer {
  private literals = new Map<string, string[]>();
  constructor(specs: ParseTagSpec[]) {
    for (const s of specs) {
      this.literals.set(s.id, [s.tag, ...(s.synonyms ?? [])]);
    }
  }
  /** Match the line as tag `id`, returning the modifier + trimmed remainder, or null. */
  match(trimmed: string, id: string): TagMatch | null {
    for (const lit of this.literals.get(id) ?? []) {
      if (MODIFIER_AWARE.has(id)) {
        const m = matchTag(trimmed, lit.slice(1, -1)); // strip surrounding [ ]
        if (m) return m;
      } else if (trimmed.startsWith(lit)) {
        return { modifier: null, rest: trimmed.slice(lit.length).trim() };
      }
    }
    return null;
  }
  /** Does the line start this tag (any literal)? Used for block-close checks. */
  is(trimmed: string, id: string): boolean {
    return this.match(trimmed, id) !== null;
  }
}

interface BoundaryMatch {
  service: string;
  rest: string;
}

function matchBoundary(trimmed: string): BoundaryMatch | null {
  // A leading `<service>:` (single colon, NOT `::`) marks a boundary step. The
  // negative lookahead on a second colon keeps a static `Noun::verb` out of the
  // boundary path. The service must be declared by a matching [SRV] — enforced
  // by the rune-service-presence lint rule, not here.
  const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_-]*):(?!:)/);
  if (!m) return null;
  return { service: m[1], rest: trimmed.slice(m[0].length) };
}

interface StepSig {
  noun: string;
  verb: string;
  params: string[];
  output: string;
  isStatic: boolean;
}

function parseStepSignature(s: string): StepSig | null {
  const trimmed = s.trim();
  const parenOpen = trimmed.indexOf("(");
  const parenClose = trimmed.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose < parenOpen) {
    return null;
  }

  const namePart = trimmed.slice(0, parenOpen);
  let sepPos: number;
  let sepLen: number;
  let isStatic: boolean;

  const dblColon = namePart.indexOf("::");
  if (dblColon !== -1) {
    sepPos = dblColon;
    sepLen = 2;
    isStatic = true;
  } else {
    const dot = namePart.indexOf(".");
    if (dot === -1) return null;
    sepPos = dot;
    sepLen = 1;
    isStatic = false;
  }

  const noun = namePart.slice(0, sepPos).trim();
  const verb = namePart.slice(sepPos + sepLen).trim();
  if (noun === "" || verb === "") return null;

  const paramsStr = trimmed.slice(parenOpen + 1, parenClose);
  const params = paramsStr
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  // Output after `):`
  const afterParen = trimmed.slice(parenClose + 1);
  const colonIdx = afterParen.indexOf(":");
  const output = colonIdx === -1 ? "" : afterParen.slice(colonIdx + 1).trim();

  return { noun, verb, params, output, isStatic };
}

interface ReqSig {
  noun: string;
  verb: string;
  input: string;
  output: string;
  /** Explicit HTTP verb (lowercased) from an `[ENT] … @ POST /…` clause. */
  method?: string;
  /** Explicit route template from `@ METHOD <template>` (e.g. `/proxy/{target}/{path*}`). */
  pathTemplate?: string;
}

/** HTTP verbs accepted in an `[ENT] … @ METHOD /…` clause (lowercased). */
const ENT_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function parseReqSignature(s: string): ReqSig | null {
  const trimmed = s.trim();
  const parenOpen = trimmed.indexOf("(");
  const parenClose = trimmed.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose < parenOpen) {
    return null;
  }

  // Output is after the LAST colon (so input may contain colons inside `{}`).
  const afterParen = trimmed.slice(parenClose + 1);
  const colonIdx = afterParen.indexOf(":");
  if (colonIdx === -1) return null;
  const output = afterParen.slice(colonIdx + 1).trim();
  const input = trimmed.slice(parenOpen + 1, parenClose).trim();

  // An optional `@ METHOD <template>` clause (`[ENT]` only) sits between the name and `(`:
  //   http.proxy @ POST /proxy/{target}/{path*}(Dto): Dto
  // Everything left of `@` is the noun.verb; `METHOD <template>` declares the route explicitly.
  let namePart = trimmed.slice(0, parenOpen);
  let method: string | undefined;
  let pathTemplate: string | undefined;
  const atIdx = namePart.indexOf("@");
  if (atIdx !== -1) {
    const clause = namePart.slice(atIdx + 1).trim();
    namePart = namePart.slice(0, atIdx);
    const sp = clause.search(/\s/);
    if (sp === -1) {
      method = clause.toLowerCase();
      pathTemplate = "";
    } else {
      method = clause.slice(0, sp).trim().toLowerCase();
      pathTemplate = clause.slice(sp + 1).trim();
    }
  }
  let noun: string;
  let verb: string;

  const dblColon = namePart.indexOf("::");
  if (dblColon !== -1) {
    noun = namePart.slice(0, dblColon).trim();
    verb = namePart.slice(dblColon + 2).trim();
  } else {
    const dot = namePart.indexOf(".");
    if (dot !== -1) {
      noun = namePart.slice(0, dot).trim();
      verb = namePart.slice(dot + 1).trim();
    } else {
      // camelCase form: verbNoun → split at first uppercase char after position 0.
      const name = namePart.trim();
      let split = -1;
      for (let i = 1; i < name.length; i++) {
        if (name[i] >= "A" && name[i] <= "Z") {
          split = i;
          break;
        }
      }
      if (split === -1) return null;
      verb = name.slice(0, split);
      const nounPart = name.slice(split);
      noun = nounPart[0].toLowerCase() + nounPart.slice(1);
    }
  }

  if (noun === "" || verb === "") return null;
  return { noun, verb, input, output, method, pathTemplate };
}

/**
 * Parse an `[ENT:ws]` socket header: `<surface> [@ /path]`. Returns the socket surface
 * (the controller noun) and the optional handshake path template — `{name}` segments are
 * translated to route params at codegen exactly like an HTTP route template. A header
 * carrying a `(...)` signature is rejected: topics are declared on indented lines below,
 * never on the header.
 */
function parseWsHeader(
  rest: string,
): { surface: string; pathTemplate: string | null } | null {
  const trimmed = rest.trim();
  if (trimmed === "" || trimmed.includes("(")) return null;
  const atIdx = trimmed.indexOf("@");
  let surface: string;
  let pathTemplate: string | null = null;
  if (atIdx === -1) {
    surface = trimmed;
  } else {
    surface = trimmed.slice(0, atIdx).trim();
    pathTemplate = trimmed.slice(atIdx + 1).trim() || null;
  }
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(surface)) return null;
  return { surface, pathTemplate };
}

/**
 * Parse one `[ENT:ws]` topic line: `<verb>(InputDto): OutputDto`. The verb is a bare
 * identifier (the message topic); the socket header supplies the surface. Empty parens
 * (`verb(): Out`) mean the topic carries no inbound payload. Returns null on any other
 * shape so the caller can report a malformed topic.
 */
function parseWsTopicSignature(
  s: string,
): { verb: string; input: string; output: string } | null {
  const trimmed = s.trim();
  const parenOpen = trimmed.indexOf("(");
  const parenClose = trimmed.lastIndexOf(")");
  if (parenOpen === -1 || parenClose === -1 || parenClose < parenOpen) {
    return null;
  }
  const verb = trimmed.slice(0, parenOpen).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(verb)) return null;
  const afterParen = trimmed.slice(parenClose + 1);
  const colonIdx = afterParen.indexOf(":");
  if (colonIdx === -1) return null;
  const output = afterParen.slice(colonIdx + 1).trim();
  if (output === "") return null;
  const input = trimmed.slice(parenOpen + 1, parenClose).trim();
  return { verb, input, output };
}

function isFaultName(s: string): boolean {
  if (s === "") return false;
  if (!(s[0] >= "a" && s[0] <= "z")) return false;
  for (const ch of s) {
    const isLower = ch >= "a" && ch <= "z";
    const isDigit = ch >= "0" && ch <= "9";
    if (!isLower && !isDigit && ch !== "-") return false;
  }
  return true;
}

function appendStepToCurrentScope(
  step: StepLike | CtrNode | RetNode,
  currentReq: ReqNode | null,
  currentPly: PlyNode | null,
  currentCse: CseNode | null,
  ast: RuneAst,
  line: number,
): void {
  if (currentCse) {
    if (step.kind === "ply") {
      ast.errors.push({
        line,
        message: "nested [PLY] inside [CSE] not supported",
      });
      return;
    }
    currentCse.steps.push(step);
    return;
  }
  if (currentReq) {
    currentReq.steps.push(step);
    return;
  }
  ast.errors.push({ line, message: `step outside [REQ]: ${step.kind}` });
}
