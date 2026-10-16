import { assertEquals } from "#assert";
import { faultResponse, RuneFault } from "./mod.ts";

Deno.test("REQ-018: a RuneFault maps to its status and body", () => {
  class NotFoundFault extends RuneFault {
    constructor(message?: string) {
      super("not-found", 404, message);
    }
  }
  const r = faultResponse(new NotFoundFault("no such task"));
  assertEquals(r, {
    status: 404,
    body: {
      name: "RuneFault",
      fault: "not-found",
      status: 404,
      message: "no such task",
    },
  });
  // A custom fault carries the status its spec line declared (`! card-expired=402`).
  const custom = faultResponse(new RuneFault("card-expired", 402));
  assertEquals(custom?.status, 402);
  assertEquals(custom?.body.message, "card-expired");
  // Duck-typed: a copy of the class from another module instance still maps.
  const foreign = Object.assign(new Error("x"), { name: "RuneFault", fault: "timeout", status: 504 });
  assertEquals(faultResponse(foreign)?.status, 504);
  // Anything else falls through to the framework's defaults.
  assertEquals(faultResponse(new Error("boom")), null);
  assertEquals(faultResponse(Object.assign(new Error("x"), { name: "RuneFault", fault: "x", status: 999 })), null);
});
