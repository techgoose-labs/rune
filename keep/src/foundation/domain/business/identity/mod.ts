// Reading the caller inside a controller.
//
// keep has no auth of its own and never did after 5.0 — but until now it also
// had no way to answer "who is this?", so every app grew its own header
// convention. It has one now, and it is not keep's: bedrock's guard runs above
// the backend on EVERY channel, and stamps the identity it produced onto the
// request envelope. A controller reads it; it cannot forge it (an inbound
// `x-bedrock-*` header is stripped at the root before the guard ever runs).

import { of } from "@techgoose-labs/bedrock";
import type { Channel, Identity } from "@techgoose-labs/bedrock";
import type { HttpContext } from "#danet/core";

/**
 * The request a danet handler was reached with, whichever shape it took: the
 * `HttpContext` (`@Ctx`), Hono's `HonoRequest` (`@Req`), or a bare `Request`.
 */
// deno-lint-ignore no-explicit-any
type RequestSource = Request | HttpContext | any;

function requestOf(source: RequestSource): Request {
  if (source instanceof Request) return source;
  // HonoRequest — what danet's `@Req()` hands a handler.
  const own = (source as { raw?: unknown })?.raw;
  if (own instanceof Request) return own;
  // HttpContext — `ctx.req` is the HonoRequest.
  const nested = (source as { req?: { raw?: unknown } })?.req?.raw;
  if (nested instanceof Request) return nested;
  throw new TypeError(
    "keep: identity() wants the danet HttpContext, the @Req() request, or a raw Request — got none of them.",
  );
}

/**
 * Who the caller is, or `null` when the route was reached openly.
 *
 *   @Get("/me")
 *   me(@Ctx() ctx: HttpContext) { return identity(ctx); }
 *
 * Present on every channel: a network request, an in-process call from the UI,
 * and a scope-less dispatch alike — whoever the auth unit's `verify` returned.
 * With no auth unit composed there is no identity, and every route is open.
 */
export function identity(source: RequestSource): Identity | null {
  return of(requestOf(source)).identity ?? null;
}

/** How the request reached the app: over the network, from another unit
 *  in-process, or scope-less (a cron tick, a test, the headless runner). */
export function channel(source: RequestSource): Channel | undefined {
  return of(requestOf(source)).channel;
}

/** The id that joins this request's capture entry, log lines, and trace. */
export function requestId(source: RequestSource): string | undefined {
  return of(requestOf(source)).requestId;
}
