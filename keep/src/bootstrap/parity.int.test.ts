// THE PARITY SUITE, against a REAL keep backend.
//
// bedrock's own `tests/parity/` proves the claim about the CHANNELS, using
// fixture units — it cannot import a backend framework. This file proves the
// same claim about the thing apps actually ship: a danet DI tree behind
// `bootstrapServer`, composed by `Bedrock({ ui, backend })`, reached over a
// real socket and reached in-process from a UI's SSR pass.
//
// The two channels must return byte-identical observables (status, body bytes,
// content-type, Set-Cookie; `response.url` origin-normalized), and the
// request-scoped jar must show ZERO cross-user bleed under concurrency — the
// cardinal invariant.

import "#reflect-metadata";
import { assert, assertEquals } from "#assert";
import { Controller, Get, Post, Req } from "#danet/core";
import { bootstrapServer } from "./mod.ts";
import { endpointModule } from "@foundation/domain/business/endpoint-decorator/mod.ts";
import { Bedrock } from "@techgoose-labs/bedrock";
import type { App, Unit } from "@techgoose-labs/bedrock";

interface Observed {
  status: number;
  body: string;
  url: string;
  contentType: string | null;
  setCookie: string[];
}

@Controller("probe")
class ProbeController {
  @Get("echo")
  echo() {
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  @Get("set")
  set() {
    return new Response(JSON.stringify({ set: true }), {
      headers: {
        "content-type": "application/json",
        "set-cookie": "csrf=xyz; Path=/; HttpOnly",
      },
    });
  }

  @Get("cookie")
  cookie(@Req() req: { raw: Request }) {
    return new Response(req.raw.headers.get("cookie") ?? "");
  }

  @Post("body")
  async body(@Req() req: { raw: Request }) {
    return new Response(JSON.stringify({ got: await req.raw.text() }), {
      headers: { "content-type": "application/json" },
    });
  }

  @Get("stream")
  stream() {
    const enc = new TextEncoder();
    const chunks = ["alpha-", "beta-", "gamma"];
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const c of chunks) controller.enqueue(enc.encode(c));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/plain" } },
    );
  }
}

const ProbeModule = endpointModule("Probe", [ProbeController]);

async function observe(res: Response): Promise<Observed> {
  return {
    status: res.status,
    body: await res.text(),
    url: new URL(res.url || "http://x/").pathname,
    contentType: res.headers.get("content-type"),
    setCookie: res.headers.getSetCookie(),
  };
}

/**
 * The UI half: it performs the in-process calls a test names, through the bag
 * ITS OWN dispatch was provisioned with, and reports what it saw. Nothing here
 * reaches into the root — this is exactly what an SSR pass does.
 */
const ui: Unit = {
  handler: async (_req, _info, bag) => {
    const url = new URL(_req.url);
    const calls = JSON.parse(url.searchParams.get("calls") ?? "[]") as {
      path: string;
      init?: RequestInit;
    }[];
    const seen: Observed[] = [];
    for (const call of calls) {
      seen.push(await observe(await bag!.fetch(call.path, call.init)));
    }
    return new Response(JSON.stringify(seen), {
      headers: { "content-type": "application/json" },
    });
  },
};

async function composed(): Promise<
  { app: App; origin: string; stop: () => Promise<void> }
> {
  const api = await bootstrapServer("parity", ProbeModule, { swagger: false });
  const app = Bedrock({ ui, backend: api });
  const { port } = await app.listen({ port: 0 });
  return {
    app,
    origin: `http://localhost:${port}`,
    stop: () => app.stop(),
  };
}

/** The in-process arm: one SSR dispatch that makes the named calls. */
async function inProcess(
  app: App,
  calls: { path: string; init?: RequestInit }[],
): Promise<Observed[]> {
  const res = await app(
    new Request(
      `http://app/ssr?calls=${encodeURIComponent(JSON.stringify(calls))}`,
    ),
  );
  return await res.json();
}

Deno.test("parity: status, body, content-type and url agree on both channels", async () => {
  const { app, origin, stop } = await composed();
  try {
    for (const path of ["/api/probe/echo", "/api/probe/stream"]) {
      const [viaClient] = await inProcess(app, [{ path }]);
      const viaWire = await observe(await fetch(`${origin}${path}`));
      assertEquals(viaClient.status, viaWire.status, path);
      assertEquals(viaClient.body, viaWire.body, `${path}: body bytes`);
      assertEquals(
        viaClient.contentType,
        viaWire.contentType,
        `${path}: content-type`,
      );
      assertEquals(viaClient.url, viaWire.url, `${path}: response.url path`);
    }
  } finally {
    await stop();
  }
});

Deno.test("parity: a POST body arrives identically on both channels", async () => {
  const { app, origin, stop } = await composed();
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ hello: "world" }),
  };
  try {
    const [viaClient] = await inProcess(app, [{
      path: "/api/probe/body",
      init,
    }]);
    const viaWire = await observe(
      await fetch(`${origin}/api/probe/body`, init),
    );
    assertEquals(viaClient.body, viaWire.body);
    assertEquals(
      JSON.parse(viaClient.body).got,
      JSON.stringify({ hello: "world" }),
    );
  } finally {
    await stop();
  }
});

Deno.test("parity: Set-Cookie is surfaced identically, and lands outside the app", async () => {
  const { app, origin, stop } = await composed();
  try {
    const [viaClient] = await inProcess(app, [{ path: "/api/probe/set" }]);
    const viaWire = await observe(await fetch(`${origin}/api/probe/set`));
    assertEquals(viaClient.setCookie, viaWire.setCookie);
    assertEquals(viaClient.setCookie, ["csrf=xyz; Path=/; HttpOnly"]);

    // And the SSR pass's own response carries it out to the browser: a cookie
    // set by a backend call during SSR must reach the user, not evaporate.
    const page = await app(
      new Request(
        `http://app/ssr?calls=${
          encodeURIComponent(JSON.stringify([{ path: "/api/probe/set" }]))
        }`,
      ),
    );
    assertEquals(page.headers.getSetCookie(), ["csrf=xyz; Path=/; HttpOnly"]);
  } finally {
    await stop();
  }
});

Deno.test("the cardinal invariant: no cross-user jar bleed under concurrency", async () => {
  const { app, stop } = await composed();
  try {
    // Twenty concurrent "users", each SSR pass carrying its own cookie. Each
    // must see ONLY its own — a jar shared between scopes would show another
    // user's value here, which is the bug the request-scoped jar exists for.
    const users = Array.from({ length: 20 }, (_, i) => `user-${i}`);
    const pages = await Promise.all(users.map((u) =>
      app(
        new Request(
          `http://app/ssr?calls=${
            encodeURIComponent(JSON.stringify([{ path: "/api/probe/cookie" }]))
          }`,
          { headers: { cookie: `who=${u}` } },
        ),
      )
    ));
    const seen = await Promise.all(
      pages.map(async (p) => (await p.json())[0].body),
    );
    for (const [i, body] of seen.entries()) {
      assertEquals(
        body,
        `who=${users[i]}`,
        `user ${i} saw another scope's jar`,
      );
    }
    assertEquals(new Set(seen).size, users.length, "every scope was distinct");
  } finally {
    await stop();
  }
});

Deno.test("the whole app is one origin: /api routes and the page share it", async () => {
  const { origin, stop } = await composed();
  try {
    const page = await fetch(`${origin}/ssr?calls=[]`);
    assertEquals(page.status, 200);
    assertEquals(await page.json(), []);
    const api = await fetch(`${origin}/api/probe/echo`);
    assertEquals(api.status, 200);
    assertEquals((await api.json()).ok, true);
    assert(
      new URL(`${origin}/api/probe/echo`).origin ===
        new URL(`${origin}/ssr`).origin,
    );
  } finally {
    await stop();
  }
});
