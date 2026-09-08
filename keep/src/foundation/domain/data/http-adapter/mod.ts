import type { Cotr, FetchHandler, HttpMethod, Type } from "@types";
import { SwaggerModule } from "#danet/swagger";
import { DanetApplication } from "#danet/core";
import { Hono } from "#hono";

// There is no in-process trust header any more, and so nothing to strip: the
// channel a request arrived on is a fact of bedrock's envelope, stamped below
// the root and unforgeable from outside it. One handler serves both channels.

export abstract class HttpAdapter {
  constructor(public defaultPort?: number) {}
  abstract listen(...args: unknown[]): Promise<{ port: number }>;
  abstract grabComponent<T extends Type<any>>(cotr: T): InstanceType<T>;
}

export class DanetHttpAdapter extends HttpAdapter {
  app: DanetApplication = new DanetApplication();
  private initialized = false;
  /** The port the server actually bound to — set once `listen()` succeeds. */
  boundPort?: number;
  constructor(defaultPort?: number) {
    super(defaultPort);
  }

  /** Initialize the module tree (register controllers, run bootstrap hooks). Idempotent. */
  async init(rootModule: Type) {
    if (this.initialized) return;
    await this.app.init(rootModule);
    this.initialized = true;
  }

  /**
   * The dispatcher in keep's OWN route space (`/users`, `/docs/_map`), for both
   * channels. Deno's connection `info` is forwarded as the request env so
   * `remoteAddr` survives when the app is mounted behind another listener.
   */
  get handler(): FetchHandler {
    const hono = this.app.router;
    return (req: Request, info?: Deno.ServeHandlerInfo) =>
      hono.fetch(req, info);
  }

  /**
   * The same routes, matched under `namespace` — what bedrock calls when keep
   * declares `mountsSelf` (D-20). Hono's `route()` does the prefix matching on
   * its own path index and passes the request through UNCHANGED, which is the
   * point: `Deno.upgradeWebSocket(req)` only succeeds on the very Request the
   * connection arrived as, so a mount that rewrites the URL breaks every
   * socket reached through `/api`.
   */
  mountedHandler(namespace: string): FetchHandler {
    const base = namespace.replace(/\/+$/, "");
    if (base === "") return this.handler;
    const mounted = new Hono().route(base, this.app.router);
    return (req: Request, info?: Deno.ServeHandlerInfo) =>
      mounted.fetch(req, info);
  }

  /**
   * No port walk, and no socket of keep's own: bedrock's lifecycle binds the
   * one listener for the whole composed app, and `PORT` is fail-loud in its env
   * registry rather than silently walking to the next free port. `rune dev`
   * keeps its own probing, in the CLI, where a dev-loop retry belongs.
   */
  listen(_rootModule: Type): Promise<{ port: number }> {
    return Promise.reject(
      new Error(
        "keep: the adapter no longer binds a socket — serve with " +
          "`Bedrock({ backend: api }).listen()` (or `api.listen()`, which is that).",
      ),
    );
  }

  registerSwaggerDocument(
    atPath: string,
    document: Parameters<typeof SwaggerModule.setup>[2],
  ) {
    SwaggerModule.setup(atPath, this.app, document);
  }

  registerRoute(
    method: Lowercase<HttpMethod>,
    path: string,
    handler: (...args: unknown[]) => unknown,
  ) {
    //@ts-ignore: methods are in router
    const registerFn = this.app.router[method];
    registerFn.call(this.app.router, path, handler);
  }

  grabComponent = <T extends Cotr>(cotr: T): InstanceType<T> =>
    this.app.get(cotr);

  async stop() {
    await this.app.close();
  }
}
