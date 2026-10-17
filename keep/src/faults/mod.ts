// Faults (REQ-018): the runtime half of the spec's `! name=STATUS` lines.
//
// Codegen emits one class per fault a module declares, extending RuneFault with
// the fault's name and HTTP status (a well-known name's status comes from the
// registry, a custom name's from its `=NNN`). A coordinator throws one; the
// bootstrap maps it to its status with a `{ fault, message }` body. Detection
// is duck-typed on `name` + `fault` + `status` — never instanceof — so it works
// when the consumer loaded its own copy of this module.

export class RuneFault extends Error {
  override readonly name = "RuneFault";
  constructor(
    /** The fault name as written in the spec, e.g. "not-found". */
    readonly fault: string,
    /** The HTTP status the runtime answers with. */
    readonly status: number,
    message?: string,
  ) {
    super(message ?? fault);
  }
}

/** The HTTP response body for a thrown fault. */
export interface FaultBody {
  name: "RuneFault";
  fault: string;
  status: number;
  message: string;
}

/** Recognize a thrown fault (duck-typed) and shape its response, or null. */
export function faultResponse(
  err: unknown,
): { status: number; body: FaultBody } | null {
  const e = err as {
    name?: unknown;
    fault?: unknown;
    status?: unknown;
    message?: unknown;
  };
  if (
    e?.name !== "RuneFault" || typeof e.fault !== "string" ||
    typeof e.status !== "number" || e.status < 100 || e.status > 599
  ) return null;
  return {
    status: e.status,
    body: {
      name: "RuneFault",
      fault: e.fault,
      status: e.status,
      message: typeof e.message === "string" ? e.message : e.fault,
    },
  };
}
