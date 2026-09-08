import type { FetchHandler, SwaggerDocEntry, Type } from "@types";
import { Server } from "@foundation/domain/business/server/mod.ts";
import { DanetHttpAdapter } from "@foundation/domain/data/http-adapter/mod.ts";
import type { HttpContext } from "#danet/core";
import type { Context } from "#hono";
// The runtime substrate is bedrock's: it mints the request id, opens the
// capture, runs the guard, and owns the lifecycle. keep boots a DI tree,
// builds docs, and hands the result back as a `Unit`.
import { Bedrock, composedIn, tracer } from "@mrg-keystone/bedrock";
import type { App, Bag, Policy, Unit } from "@mrg-keystone/bedrock";
import {
  exerciseEndpoints,
  type ExerciseOptions,
} from "@foundation/domain/coordinators/exercise-harness/mod.ts";
import {
  callHealer,
  healConfigured,
} from "@foundation/domain/business/heal/mod.ts";
import { appModule } from "@foundation/domain/business/endpoint-decorator/mod.ts";
import { checkBody } from "@foundation/domain/business/body-gateway/mod.ts";
import {
  createDocsJsonHandler,
  injectDocsScript,
  swaggerShellHtml,
} from "@foundation/domain/business/docs-ui/mod.ts";
// Static imports (no dynamic chunks): a lazily-imported chunk that shares modules with a
// top-level-awaiting entry deadlocks under rollup-bundled output ("Top-level await promise
// never resolved" in `deno serve _fresh/server.js`). The chain is bundler-clean since
// handlebars was replaced with template literals, so eager loading is safe everywhere.
import { SwaggerBuilder } from "@foundation/domain/business/swagger-builder/mod.ts";
import { emulatorShellHtml } from "@foundation/domain/business/emulator-ui/mod.ts";
import { mapShellHtml } from "@foundation/domain/business/map-ui/mod.ts";
import { traceShellHtml } from "@foundation/domain/business/trace-ui/mod.ts";
import { endpointsFromDoc } from "@foundation/domain/business/endpoint-spec/mod.ts";
import {
  type FixturesPatch,
  mergeFixtures,
  normalizeScenario,
  readFixtures,
  readHealRules,
  readScenarios,
  scenarioSlug,
  writeFixtures,
  writeScenario,
} from "@foundation/domain/business/fixtures-store/mod.ts";

/**
 * Handed to {@link BootstrapOptions.onStart}/{@link BootstrapOptions.onStop}. It is bedrock's
 * bag plus the bound port: `backend` is the scope-less in-process client (kept under its 6.x
 * name; it is `fetch` on bedrock's bag), `fetch` the same client, `app` the app's identity, and
 * `policy` the merged table. `port` is the actually-bound port under `listen()`, or `0` under the
 * handler path (`deno serve`), where nothing binds a socket.
 *
 * The client dispatches at WIRE paths (D-7): a keep route lives at `/api/<…>` in the composed
 * app, so call `backend.fetch("/api/users")`, not `/users`.
 */
export interface ServerLifecycle extends Bag {
  backend: { fetch: typeof fetch };
  port: number;
}

/** A teardown callback. Returned from `onStart`, run by `stop()` before `onStop`. */
export type ServerDisposer = () => void | Promise<void>;

export interface BootstrapOptions {
  port?: number;
  swagger?: boolean | { filters: string[] };
  /**
   * Extra policy rows, merged after the ones derived from the docs (D-3).
   *
   * The derived table covers every `@Endpoint`, because each one carries its
   * own `x-bedrock-auth` marker. A route registered any OTHER way — a raw
   * `@Post` a controller hand-writes, a webhook whose body is not a DTO — has
   * no operation in the docs and so no row, and would fall to the slot default.
   * Declare it here rather than leaving it to be discovered in production.
   */
  policy?: Policy;
  /**
   * Called ONCE when the server goes live — the first-class home for a background loop (an
   * orchestrator heartbeat, a queue drainer) that `deno serve` cannot host itself because it never
   * runs `import.meta.main`. Fires from `listen()`, or lazily on the first request under the
   * handler path (`deno serve`), whichever happens first. It is guarded to run at most once per
   * server, so a `--watch` reload or a double `listen()` can't start two intervals (the
   * double-interval footgun apps otherwise hand-guard with a `globalThis` symbol). Return a
   * disposer (e.g. `() => clearInterval(id)`) and `stop()` runs it for you.
   */
  onStart?: (
    ctx: ServerLifecycle,
  ) => void | ServerDisposer | Promise<void | ServerDisposer>;
  /** Called ONCE during `stop()`, after the `onStart` disposer — symmetric teardown. */
  onStop?: (ctx: ServerLifecycle) => void | Promise<void>;
}

// The env registry is bedrock's (spec/environment-variables): DD_API_KEY,
// DENO_DEPLOY, KEEP_DD_LOCAL, POSTMARK_*, ALERT_RECIPIENTS, KEEP_TRACE*, PORT
// and the removed-variable ledger are all read there, once, at the boundary.
// keep reads only what is keep's: KEEP_DEV, and the fixtures/heal paths.

const warned = new Set<string>();
function warnOnce(message: string) {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(message);
}

/**
 * The policy rows keep's unit declares for its own control plane (D-3, D-11).
 * Bedrock merges and resolves them; keep never gates a route itself.
 *
 *   - `/docs/*` — the emulator, the map, the traces, the fixtures, the runner.
 *     Open in dev (`KEEP_DEV`) and, with no auth unit composed, open anyway
 *     because an app without an auth slot has nothing to authenticate against.
 *     Under an auth unit in production they are `authenticated` — the gate the
 *     old "localhost-only" comments claimed and no code enforced.
 *   - `POST /docs/_run` — the headless runner's own door (D-19). In dev it is
 *     open so the cake can drive the process; otherwise it follows the rest.
 *
 * Everything else comes from the OpenAPI docs: each operation's
 * `x-bedrock-auth: { access }`, which rune's codegen emits from the `[REQ]`
 * openness marker. No marker ⇒ the slot default (`authenticated`).
 */
function controlPlanePolicy(dev: boolean): Policy {
  const access = dev ? "open" as const : "authenticated" as const;
  return [
    { path: "/docs/*", access },
    { path: "/docs", access },
  ];
}

/**
 * Derive the route policy from the docs keep already builds (D-3). Bedrock
 * never parses OpenAPI: keep reads its own `x-bedrock-auth` extension and
 * hands bedrock a plain table.
 */
export function policyFromDocs(docs: SwaggerDocEntry[]): Policy {
  const rows: Policy = [];
  for (const entry of docs) {
    const paths =
      (entry.doc as unknown as { paths?: Record<string, unknown> })?.paths ??
        {};
    for (const [path, operations] of Object.entries(paths)) {
      for (
        const [method, operation] of Object.entries(
          operations as Record<string, unknown>,
        )
      ) {
        const marker =
          (operation as { "x-bedrock-auth"?: { access?: unknown } })?.[
            "x-bedrock-auth"
          ];
        const access = marker?.access;
        if (access === undefined) continue; // no marker ⇒ the slot default
        rows.push({
          method: method.toUpperCase(),
          // Docs paths carry OpenAPI's `{param}` templates; a policy path
          // matches by prefix, so a templated segment becomes a wildcard tail.
          path: path.includes("{")
            ? `${path.slice(0, path.indexOf("{"))}*`
            : path,
          access: access as Policy[number]["access"],
        });
      }
    }
  }
  return rows;
}

// Dev-mode boot identity (`rune dev`): minted once per process so the emulator pages' reload
// poller can tell "the same app answered" from "a NEW process is serving" after a restart.
const bootId = crypto.randomUUID();

// danet's global exception-filter container is process-wide and append-only;
// guard so repeated bootstrapServer() calls (test suites, in-process reboots)
// register the stateless RuneAssertError→422 filter exactly once.
let runeAssertFilterRegistered = false;

export class BootstrapServer {
  private adapter: DanetHttpAdapter;
  private module: Type;
  /** The per-module OpenAPI docs (with `x-keep-process`) built at boot; empty when swagger is off. */
  readonly docs: SwaggerDocEntry[];
  /** The route policy this unit declares — the control plane plus whatever the
   *  docs' `x-bedrock-auth` markers say (D-3, D-11). */
  readonly policy: Policy;

  readonly appName: string;

  /** Forwarded onto the unit; bedrock's lifecycle owns the once-guards now. */
  readonly onStart?: BootstrapOptions["onStart"];
  readonly onStop?: BootstrapOptions["onStop"];
  /** Records the bag the root provisions, so the runner can drive the app. */
  readonly captureBag: (bag?: Bag, namespace?: string) => void;

  private constructor(
    module: Type,
    adapter: DanetHttpAdapter,
    docs: SwaggerDocEntry[],
    policy: Policy,
    appName: string,
    lifecycle: Pick<BootstrapOptions, "onStart" | "onStop"> | undefined,
    captureBag: (bag?: Bag, namespace?: string) => void,
  ) {
    this.module = module;
    this.adapter = adapter;
    this.docs = docs;
    this.policy = policy;
    this.appName = appName;
    this.onStart = lifecycle?.onStart;
    this.onStop = lifecycle?.onStop;
    this.captureBag = captureBag;
  }

  static async create(
    appName: string,
    module: Type | Type[],
    options?: BootstrapOptions,
  ) {
    // An array composes into one root module (one entry per rune) — see appModule(). Each
    // child keeps its own Swagger doc; the wrapper itself is skipped by the docs builder.
    const rootModule = Array.isArray(module)
      ? appModule(appName, module)
      : module;
    const { port, swagger = true, onStart, onStop } = options ?? {};

    // Observability is bedrock's, configured once at its boundary from the one
    // env registry — the logger, the tracer, the KV trace sink, the OTLP
    // shipper and the removed-variable ledger all moved there. keep no longer
    // reads DD_API_KEY, POSTMARK_*, KEEP_TRACE* or DENO_DEPLOY at all.
    //
    // ASSUMPTION (unchanged): one BootstrapServer per process. The danet
    // exception filter and `bootId` are process-global singletons.

    const server = Server.create();
    server.registerModule(rootModule);

    const adapter = new DanetHttpAdapter(port);
    void adapter.defaultPort; // the adapter binds nothing; bedrock's lifecycle does
    // No request-logging middleware and no auth guard: a dispatch is captured
    // and guarded ONCE, at bedrock's boundary, on every channel. A middleware
    // here would double-count the in-process calls the root already recorded.
    type RouteHandler = (...args: unknown[]) => unknown;

    // Dev mode (`rune dev` sets KEEP_DEV to a status-file path): serve `/docs/_dev` so the
    // emulator pages can poll for restarts (bootId change) and spec-check errors, and inject
    // the reload poller into every emulator page.
    const devStatusPath = Deno.env.get("KEEP_DEV");

    let docs: SwaggerDocEntry[] = [];
    // Late-bound: the backend client exists only after init; /docs/_run answers
    // 503 in the boot window instead of capturing a dead reference.
    let runTarget:
      | {
        backend: { fetch: typeof fetch };
        docs: SwaggerDocEntry[];
        namespace?: string;
      }
      | null = null;
    if (swagger) {
      const filters = typeof swagger === "object" ? swagger.filters : [];
      const builder = new SwaggerBuilder(...filters);
      const { swaggerDocs, docsIndexHtml } = await builder.build(server);
      docs = swaggerDocs as unknown as SwaggerDocEntry[];

      const html = (body: string) =>
        new Response(body, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });

      if (devStatusPath) {
        adapter.registerRoute("get", "/docs/_dev", async () => {
          // The status file is written by the watcher between polls — a missing file, a
          // partial write or junk content must never break the channel: degrade to bootId only.
          let status: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(await Deno.readTextFile(devStatusPath));
            if (
              parsed !== null && typeof parsed === "object" &&
              !Array.isArray(parsed)
            ) {
              status = parsed;
            }
          } catch {
            status = {};
          }
          return new Response(JSON.stringify({ ...status, bootId }), {
            headers: { "content-type": "application/json" },
          });
        });
      }

      // Contract auto-wiring index across the composed app: output field name →
      // "<module>:<endpointId>" of the endpoint producing it (first producer wins; stub
      // endpoints are producers too). Each emulator page receives the slice covering its own
      // declared $inputs, so an unset input can auto-resolve from a producer's shared capture.
      const moduleEntries = docs.map(({ path, doc }) => ({
        path,
        doc,
        moduleName: path.replace(/^\//, ""),
        endpoints: endpointsFromDoc(doc),
      }));
      const producersByField = new Map<string, string>();
      for (const { moduleName, endpoints } of moduleEntries) {
        for (const ep of endpoints) {
          for (const field of ep.outputFields) {
            // An echo (consumes the field it outputs) can never bootstrap a value — not a
            // producer for contract purposes.
            if (ep.inputFields.includes(field) || field in ep.bind) continue;
            if (!producersByField.has(field)) {
              producersByField.set(field, `${moduleName}:${ep.id}`);
            }
          }
        }
      }
      // `$name` is satisfiable by an exact `name` output, or by a `name + "s"` collection whose
      // first element supplies the value (the plural half of the composition contract).
      const producerForInput = (name: string): string | undefined =>
        producersByField.get(name) ?? producersByField.get(`${name}s`);
      // App-wide endpoint index for the cake's Module-setup picker: setup can call ANY composed
      // module's endpoint to put the whole app in a known state, so every page gets the slim
      // request-building slice (schema, binds, params) of every endpoint in the app.
      const appEndpoints = moduleEntries.flatMap(({ moduleName, endpoints }) =>
        endpoints.map((ep) => ({
          module: moduleName,
          id: ep.id,
          method: ep.method,
          path: ep.path,
          description: ep.description ?? "",
          bind: ep.bind,
          inputSchema: ep.inputSchema,
          params: ep.params,
        }))
      );

      for (const { path, doc, moduleName, endpoints } of moduleEntries) {
        const title = `API · ${moduleName}`;
        // This module's $inputs that some composed endpoint (any module, including this one)
        // genuinely produces — exact field or its plural collection; echoes never count. The
        // consumer itself can't be its own producer. Names with no producer stay explicit-only.
        const producers: Record<string, string> = {};
        for (const ep of endpoints) {
          for (const ref of Object.values(ep.bind)) {
            for (const candidate of Array.isArray(ref) ? ref : [ref]) {
              if (!candidate.startsWith("$")) continue;
              const name = candidate.slice(1);
              const producer = producerForInput(name);
              if (!producer || producer === `${moduleName}:${ep.id}`) continue;
              producers[name] = producer;
            }
          }
        }
        // Default page: the process emulator (ordered, chainable, click-through). Public shell;
        // the inlined spec renders it, and live endpoint calls carry the stored token.
        adapter.registerRoute(
          "get",
          `/docs${path}`,
          () =>
            html(
              injectDocsScript(emulatorShellHtml(moduleName, doc, {
                producers,
                appEndpoints,
                dev: Boolean(devStatusPath),
              })),
            ),
        );
        // Standard Swagger UI for deeper inspection, moved under /swagger.
        adapter.registerRoute(
          "get",
          `/docs${path}/swagger`,
          () => html(swaggerShellHtml(title)),
        );
        // Gated spec: the in-process client needs no token; every other caller must present an
        // infra bearer whose app-grants include `dev` or `*` (Authorization header or ?token).
        adapter.registerRoute(
          "get",
          `/docs${path}/json`,
          createDocsJsonHandler({
            specJson: JSON.stringify(doc),
          }) as RouteHandler,
        );
      }
      // The whole-app system map: every module's endpoints as one process graph, with live
      // run state read from the emulator sessions. Underscore-prefixed so a module named
      // "map" can still own /docs/map.
      adapter.registerRoute(
        "get",
        "/docs/_map",
        () =>
          html(
            injectDocsScript(
              mapShellHtml(appName, docs, { dev: Boolean(devStatusPath) }),
            ),
          ),
      );
      // The request-trace waterfall: every recent real request as a bar, each user function timed
      // as a segment, with a ✕ where a request crashed. The page (public shell) polls the data
      // route below; the data — route paths, error messages, captured timing — is localhost-only.
      adapter.registerRoute(
        "get",
        "/docs/_trace",
        () =>
          html(
            injectDocsScript(
              traceShellHtml(appName, { dev: Boolean(devStatusPath) }),
            ),
          ),
      );
      // Trace data + control. GET returns the newest-first ring buffer; POST {clear:true} empties
      // it. Localhost-only (same posture as /_run, /_heal) since traces can carry request detail.
      adapter.registerRoute(
        "get",
        "/docs/_traces",
        (async (c: Context) => {
          // `?user=` scopes to one user server-side (a fast indexed scan under KV); `?limit=`
          // caps the page (default 200, hard ceiling 1000).
          const user = c.req.query("user") || undefined;
          const limitQ = Number(c.req.query("limit"));
          const limit = Number.isFinite(limitQ) && limitQ > 0
            ? Math.min(limitQ, 1000)
            : 200;
          const [traces, users] = await Promise.all([
            tracer.list({ user, limit }),
            tracer.users(),
          ]);
          return c.json({
            app: appName,
            enabled: tracer.enabled,
            persistent: tracer.isPersistent(),
            users,
            traces,
          });
        }) as RouteHandler,
      );
      adapter.registerRoute(
        "post",
        "/docs/_traces",
        (async (c: Context) => {
          let body: Record<string, unknown> = {};
          try {
            body = (await c.req.json()) as Record<string, unknown>;
          } catch {
            body = {};
          }
          if (body.clear === true) await tracer.clear();
          return c.json({ ok: true, traces: await tracer.list() });
        }) as RouteHandler,
      );
      // Headless "Run all in order" over HTTP: a localhost-only door to exerciseEndpoints so an
      // agent, CI, or the map UI can ask a running server "does the whole composed process work
      // right now?" and get a machine-readable verdict. Same blast radius as a human clicking
      // Run all, so it takes the localhost-only trust posture exactly — loopback socket only, and
      // in-process dispatch (which has no conn info) is denied. 503 until the backend exists.
      adapter.registerRoute(
        "post",
        "/docs/_run",
        (async (c: Context) => {
          if (!runTarget) {
            return c.json({
              error:
                "No in-process client: this dispatch did not come through the composition root. " +
                "Serve the app with Bedrock({ backend: api }) (or api.listen(), which is that) — " +
                "the runner drives the composed app, not the unit in isolation.",
            }, 503);
          }
          let body: Record<string, unknown> = {};
          try {
            body = (await c.req.json()) as Record<string, unknown>;
          } catch {
            body = {}; // empty/invalid body ⇒ exercise everything with defaults
          }
          // scenario: "<name>" replays a saved spec/misc/scenarios file headlessly: its flow plus
          // each step's LITERAL body fields as byEndpoint overrides. Fields holding {{refs}} are
          // dropped — the runner fills those through its own bind machinery, which the refs mirror.
          let scenarioFlow: string | undefined;
          let scenarioByEndpoint:
            | Record<string, Record<string, unknown>>
            | undefined;
          if (typeof body.scenario === "string" && body.scenario !== "") {
            const wanted = scenarioSlug(body.scenario);
            const scenario = (await readScenarios()).find((s) =>
              scenarioSlug(s.name) === wanted
            );
            if (!scenario) {
              return c.json(
                { error: `Unknown scenario "${body.scenario}".` },
                404,
              );
            }
            scenarioFlow = scenario.flow;
            scenarioByEndpoint = {};
            for (const step of scenario.steps) {
              if (step.skip || !step.body) continue;
              try {
                const parsed = JSON.parse(step.body) as Record<string, unknown>;
                const literals: Record<string, unknown> = {};
                for (const [k, v] of Object.entries(parsed)) {
                  if (typeof v === "string" && v.includes("{{")) continue;
                  literals[k] = v;
                }
                if (Object.keys(literals).length) {
                  scenarioByEndpoint[step.id] = literals;
                }
              } catch {
                // unparseable frozen body — leave that step to the runner's defaults
              }
            }
          }
          // Transient slugs come from the project's own heal rules: any slug with a `retry`
          // action (or a `note` with retryAfter) is declared "worth re-attempting", and the
          // built-in transients always are. The walk then waits-and-retries those instead of
          // failing — heal knowledge feeding the runner, not just the UI.
          const healRules = await readHealRules();
          const retrySlugs = new Set<string>(["timeout", "rate-limited"]);
          for (const [slug, rules] of Object.entries(healRules.slugs)) {
            for (const rule of rules) {
              if (
                rule.kind === "retry" ||
                (rule.kind === "note" && rule.retryAfter)
              ) {
                retrySlugs.add(slug);
              }
            }
          }
          const opts: ExerciseOptions = {
            api: runTarget,
            flow: typeof body.flow === "string" ? body.flow : scenarioFlow,
            retry: { slugs: [...retrySlugs] },
            orderBy: body.orderBy === "module" ? "module" : undefined,
            skip: Array.isArray(body.skip)
              ? (body.skip as unknown[]).filter((s): s is string =>
                typeof s === "string"
              )
              : undefined,
            rateLimit: body.rateLimit as ExerciseOptions["rateLimit"],
            maxIterations: typeof body.maxIterations === "number"
              ? body.maxIterations
              : undefined,
            dryRun: body.dryRun === true,
            overrides: {
              seeds: body.seeds as Record<string, unknown> | undefined,
              byEndpoint: (body.byEndpoint ?? scenarioByEndpoint) as
                | Record<string, Record<string, unknown>>
                | undefined,
              // D-19: the runner's dispatches are SCOPE-LESS, so an auth unit
              // denies them unless credentialed. `credential` is an
              // Authorization value the auth unit recognizes, forwarded on
              // every call — never a bedrock bypass. Falls back to the
              // caller's own Authorization header, so `curl -H` works.
              auth: (() => {
                const credential = typeof body.credential === "string"
                  ? body.credential
                  : c.req.header("authorization");
                return credential
                  ? {
                    kind: "bearer" as const,
                    bearer: credential.replace(/^Bearer /i, ""),
                  }
                  : undefined;
              })(),
            },
          };
          // stream: true → ndjson. One {kind:"result",…} line per attempt AS IT COMPLETES (the
          // map paints nodes live from these), then a final {kind:"done",…} summary. Errors
          // mid-run become a {kind:"error"} line — the stream itself always ends cleanly.
          if (body.stream === true && !opts.dryRun) {
            const encoder = new TextEncoder();
            const stream = new ReadableStream<Uint8Array>({
              start(controller) {
                const send = (obj: unknown) =>
                  controller.enqueue(
                    encoder.encode(JSON.stringify(obj) + "\n"),
                  );
                exerciseEndpoints({
                  ...opts,
                  onResult: (r) => send({ kind: "result", ...r }),
                }).then((report) => {
                  send({
                    kind: "done",
                    ok: report.failed.length === 0 &&
                      report.cycles.length === 0,
                    passed: report.passed.length,
                    failed: report.failed,
                    optionalFailed: report.optionalFailed,
                    cycles: report.cycles,
                    iterations: report.iterations,
                  });
                  controller.close();
                }).catch((e) => {
                  send({
                    kind: "error",
                    error: e instanceof Error ? e.message : String(e),
                  });
                  controller.close();
                });
              },
            });
            return new Response(stream, {
              headers: { "content-type": "application/x-ndjson" },
            });
          }
          const report = await exerciseEndpoints(opts);
          if (opts.dryRun) {
            return c.json({
              order: report.order,
              cycles: report.cycles,
              unresolvedInputs: report.unresolvedInputs,
            });
          }
          return c.json({
            ok: report.failed.length === 0 && report.cycles.length === 0,
            passed: report.passed,
            failed: report.failed,
            optionalFailed: report.optionalFailed,
            order: report.order,
            cycles: report.cycles,
            iterations: report.iterations,
          });
        }) as RouteHandler,
      );
      // Self-healing bridge: POST /docs/_heal forwards an emulator failure
      // bundle (plus the whole composed process graph) to the configured
      // private Claude service and returns its structured verdict. The
      // emulator's RULES run client-side first; this is the long tail.
      // Localhost-only — the bundle carries session data and the upstream
      // call spends the operator's Claude plan.
      adapter.registerRoute(
        "post",
        "/docs/_heal",
        (async (c: Context) => {
          if (!healConfigured()) {
            return Response.json({
              error:
                "healer not configured — set PRIVATE_CLAUDE_URL (and PRIVATE_CLAUDE_TOKEN) on the server",
            }, { status: 503 });
          }
          let bundle: Record<string, unknown> = {};
          try {
            bundle = await c.req.json();
          } catch {
            // empty body → heal with graph context only
          }
          const graph = docs.map((d) => ({
            module: d.path,
            endpoints: endpointsFromDoc(d.doc).map((ep) => ({
              id: ep.id,
              method: ep.method,
              path: ep.path,
              order: ep.order,
              dependsOn: ep.dependsOn,
              bind: ep.bind,
              flows: ep.flows,
              optional: ep.optional,
              inputFields: ep.inputFields,
              outputFields: ep.outputFields,
            })),
          }));
          try {
            return Response.json(await callHealer(bundle, graph));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return Response.json({ error: msg }, { status: 502 });
          }
        }) as RouteHandler,
      );
      // The cake's persistent config artifact (spec/misc/cake.json): per-module setup steps and
      // the variables a user marked "persist". GET restores it on cake load; POST merges a page's
      // slice and writes it back. Localhost-only (same posture as /_run, /_heal) — the
      // artifact carries variable values and writes the dev machine's disk.
      adapter.registerRoute(
        "get",
        "/docs/_fixtures",
        (async (c: Context) => {
          return c.json(await readFixtures());
        }) as RouteHandler,
      );
      adapter.registerRoute(
        "post",
        "/docs/_fixtures",
        (async (c: Context) => {
          let patch: FixturesPatch = {};
          try {
            patch = (await c.req.json()) as FixturesPatch;
          } catch {
            patch = {}; // empty/invalid body ⇒ a no-op merge that just re-stamps the file
          }
          try {
            const merged = await writeFixtures(
              mergeFixtures(await readFixtures(), patch),
            );
            return c.json(merged);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            // Most likely cause: the app was started without --allow-write.
            return c.json(
              { error: `Could not write spec/misc/cake.json — ${msg}` },
              500,
            );
          }
        }) as RouteHandler,
      );
      // Project heal rules (spec/misc/heal-rules.json): the declarative per-project tier of the
      // cake's heal panel — error slug → suggestions. keep executes them; the project (usually
      // rune, from spec fault slugs) authors them. Missing file ⇒ empty rule set, generic tier only.
      adapter.registerRoute(
        "get",
        "/docs/_heal-rules",
        (async (c: Context) => {
          return c.json(await readHealRules());
        }) as RouteHandler,
      );
      // Scenarios (spec/misc/scenarios/<name>.json): named, committable snapshots of a module's
      // walk (flow + per-step bodies/params). GET lists them all; POST saves one (same name
      // overwrites). The cake offers load/run; /docs/_run accepts { scenario } for CI replay.
      adapter.registerRoute(
        "get",
        "/docs/_scenarios",
        (async (c: Context) => {
          return c.json({ scenarios: await readScenarios() });
        }) as RouteHandler,
      );
      adapter.registerRoute(
        "post",
        "/docs/_scenarios",
        (async (c: Context) => {
          let parsed: unknown = null;
          try {
            parsed = await c.req.json();
          } catch {
            parsed = null;
          }
          const scenario = normalizeScenario(parsed);
          if (!scenario) {
            return c.json(
              { error: "A scenario needs at least { name, module, steps }." },
              400,
            );
          }
          try {
            return c.json(await writeScenario(scenario));
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return c.json(
              { error: `Could not write the scenario file — ${msg}` },
              500,
            );
          }
        }) as RouteHandler,
      );
      // Public index: seeds the token from ?token into localStorage for the doc pages.
      adapter.registerRoute(
        "get",
        "/docs",
        () => html(injectDocsScript(docsIndexHtml)),
      );
    }

    // Initialize eagerly so the in-process `backend` client is usable without listen().
    await adapter.init(rootModule);

    // Rune assert failures (thrown at validated seams by code importing
    // @mrg-keystone/rune/assert) map to HTTP 422. Detection is duck-typed on
    // name + failures — NOT instanceof — so it works even when the consumer
    // loaded its own copy of the assert module. Returning undefined falls
    // through to danet's defaults: auth HttpExceptions keep their status and
    // plain errors stay 500. danet's global-filter container is PROCESS-wide
    // and never drained by stop(), so register exactly once per process —
    // the filter is stateless, one registration serves every app.
    if (!runeAssertFilterRegistered) {
      runeAssertFilterRegistered = true;
      adapter.app.useGlobalExceptionFilter({
        catch(err: unknown, ctx: HttpContext) {
          const e = err as {
            name?: unknown;
            target?: unknown;
            context?: unknown;
            failures?: unknown;
          };
          if (e?.name === "RuneAssertError" && Array.isArray(e.failures)) {
            return ctx.json(
              {
                name: "RuneAssertError",
                message: (err as Error).message,
                target: e.target,
                context: e.context ?? null,
                failures: e.failures,
              },
              422,
            );
          }
          return undefined;
        },
      });
    }

    // There is no keep-minted in-process client any more (and no trust marker
    // to mint it with): the ONE client is bedrock's, provisioned per scope and
    // handed to the unit in the bag (C4, D-13). Captured on the first dispatch
    // — which always precedes any route body — so `/docs/_run` drives the
    // process through the same instrumented root everything else enters by.
    const captureBag = (bag?: Bag, namespace?: string) => {
      if (bag && !runTarget) {
        runTarget = { backend: { fetch: bag.fetch }, docs, namespace };
      }
    };

    return new BootstrapServer(
      rootModule,
      adapter,
      docs,
      [
        ...controlPlanePolicy(Boolean(devStatusPath)),
        ...policyFromDocs(docs),
        ...(options?.policy ?? []),
      ],
      appName,
      { onStart, onStop },
      captureBag,
    );
  }

  /**
   * The unit's dispatcher, in ROUTE space (`/users`, `/docs/_map`). keep
   * declares `mountsSelf`, so bedrock hands it the ORIGINAL request with the
   * `/api` prefix intact and this Hono mount does the matching — which is what
   * makes a WebSocket upgrade through `/api` work at all (D-20): rewriting the
   * request would hand `Deno.upgradeWebSocket` a Request that is no longer the
   * one the connection belongs to.
   */
  get handler(): FetchHandler {
    return this.adapter.handler;
  }

  /** The mounted dispatcher bedrock actually calls, at `namespace`. */
  mountedHandler(namespace: string): FetchHandler {
    return this.adapter.mountedHandler(namespace);
  }

  /** Close the DI container. Run from the unit's `onStop`, after the app's. */
  close(): Promise<void> {
    return this.adapter.stop();
  }
}

/** What `bootstrapServer()` resolves to: a bedrock `Unit`, plus keep's own
 *  surface for the apps and tools that drive a backend directly. */
export interface KeepUnit extends Unit {
  /** The per-module OpenAPI docs built at boot. */
  docs: SwaggerDocEntry[];
  /** The scope-less in-process client — `app.client` of the private root. */
  backend: { fetch: typeof fetch };
  /** Bind a socket and start. Standalone shape; `Bedrock({ backend: api })`
   *  when the app composes more than one unit. */
  listen: (opts?: { port?: number }) => Promise<{ port: number }>;
  stop: () => Promise<void>;
  /** Mount the unit somewhere other than `/api`. */
  mount: (namespace: string) => Unit;
  /** @deprecated Compose with `Bedrock({ ui, backend })`. Removed in keep 8. */
  compose: (options?: { frontend?: Unit | FetchHandler }) => FetchHandler;
}

/** keep's default namespace in a composed app — bedrock's `backend` slot. */
export const KEEP_NAMESPACE = "/api";

/**
 * Boot a keep backend and return it as a bedrock `Unit`.
 *
 *   // serve.ts
 *   export default Bedrock({ backend: api });
 *
 * The unit is everything bedrock needs to place keep in an app: a handler in
 * its own route space, the namespace it mounts at, the policy table derived
 * from its docs, and the lifecycle hooks the app declared. `listen`/`stop`/
 * `backend` remain for the standalone shape and for the tools that drive a
 * backend directly — each of them an adapter over a PRIVATE
 * `Bedrock({ backend: unit })`, so even "just keep" runs through the same
 * instrumented root, with the same guard and the same one client.
 */
export async function bootstrapServer(
  appName: string,
  module: Type | Type[],
  options?: BootstrapOptions,
): Promise<KeepUnit> {
  const server = await BootstrapServer.create(appName, module, options);

  const unitAt = (namespace: string): Unit => ({
    name: appName,
    namespace,
    // D-20: keep matches the prefix itself, so the request reaching a route is
    // byte-for-byte the one that arrived — the precondition for an upgrade.
    mountsSelf: true,
    handler: (() => {
      const dispatch = server.mountedHandler(namespace);
      return async (req: Request, info?: Deno.ServeHandlerInfo, bag?: Bag) => {
        server.captureBag(bag, namespace);
        // A bodyless request — an upgrade among them — is passed through
        // untouched, so `mountsSelf`'s guarantee holds where it matters.
        const checked = await checkBody(req);
        if (checked instanceof Response) return checked;
        return dispatch(checked, info);
      };
    })(),
    policy: server.policy,
    onStart: server.onStart
      ? (ctx) => server.onStart!({ ...ctx, backend: { fetch: ctx.fetch } })
      : undefined,
    // Always present: the app's own hook (if any) runs first, then the DI tree
    // closes. Nothing else closes it — bedrock shuts the socket, not the
    // container it knows nothing about.
    onStop: async (ctx) => {
      if (server.onStop) {
        await server.onStop({ ...ctx, backend: { fetch: ctx.fetch } });
      }
      await server.close();
    },
  });

  const unit = unitAt(KEEP_NAMESPACE);

  // The private root. Built lazily so an app that composes the unit itself
  // (`Bedrock({ ui, backend: api })` — the normal case) never stands up a
  // second one; only `listen`/`stop`/`backend` reach for it.
  let root: App | null = null;
  const standalone = (): App => (root ??= Bedrock({ backend: unit }));

  // The object the APP composes is this one — a spread of `unit` plus keep's
  // surface — so the composition stamp lands here, not on `unit`.
  const composed: KeepUnit = {
    ...unit,
    docs: server.docs,
    /**
     * The scope-less in-process client. A call from a cron tick or a test has
     * no request to be bound to, and the auth unit sees `channel: "scope-less"`.
     *
     * It is THE COMPOSED APP's client whenever this unit has been composed into
     * one. That is not a nicety: the private root below has no `auth` slot, so
     * handing out its client from inside a guarded app would answer 200 on a
     * route the app itself answers 401 for — a bypass, reachable by anyone
     * holding `api`. Composition is stamped on the unit before any dispatch, so
     * even code that reads this at module scope gets the right client.
     */
    get backend(): { fetch: typeof fetch } {
      return composedIn(composed) ?? standalone().client;
    },
    // `bootstrapServer(..., { port })` still names the port; bedrock's env
    // registry supplies `PORT` when neither says.
    listen: (opts) =>
      standalone().listen({ port: opts?.port ?? options?.port }),
    stop: () => (root ? root.stop() : Promise.resolve()),
    mount: unitAt,
    compose: (opts = {}) => {
      warnOnce(
        `[${appName}] api.compose() is deprecated and is removed in keep 8 — ` +
          `compose with Bedrock({ ui: Frontend(), backend: api }) in serve.ts instead.`,
      );
      const frontend = opts.frontend;
      const ui = typeof frontend === "function"
        ? { handler: frontend }
        : frontend;
      return Bedrock(ui ? { ui, backend: unit } : { backend: unit });
    },
  };
  return composed;
}

/** @deprecated Options of the one-release `Backend()` adapter. */
export interface BackendOptions {
  swagger?: BootstrapOptions["swagger"];
  onStart?: BootstrapOptions["onStart"];
  onStop?: BootstrapOptions["onStop"];
  frontend?: Unit | FetchHandler;
}

/**
 * @deprecated The 6.x "layer" shape, kept for one release (D-6). It boots the
 * unit lazily on the first request and composes it exactly as
 * `Bedrock({ ui: frontend, backend: api })` does — which is what to write
 * instead, in a `serve.ts` the toolchain generates. Removed in keep 8.
 */
export function Backend(
  appName: string,
  module: Type | Type[],
  options: BackendOptions = {},
): FetchHandler {
  warnOnce(
    `[${appName}] Backend() is deprecated and is removed in keep 8 — ` +
      `compose with Bedrock({ ui: Frontend(), backend: api }) in serve.ts instead.`,
  );
  const { frontend, ...bootstrapOpts } = options;
  let ready: Promise<FetchHandler> | null = null;
  const boot = () => (ready ??= bootstrapServer(appName, module, bootstrapOpts)
    .then((api) => api.compose({ frontend })));
  return async (req, info) => (await boot())(req, info);
}
