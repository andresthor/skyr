/**
 * What a host that embeds Pi offers extensions over Pi's event bus, in the `tengi:` contract. A
 * `tengi:capabilities?` query is answered inside the asking `emit`, so it is synchronous; a
 * `tengi:form?` request carries its own abort signal and reply callbacks, so no later reply has to
 * cross the bus, where a reload would drop this extension's listeners.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Events = ExtensionAPI["events"];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * True only for a v1 reply to this query with `forms` and `formRequests` both true, so a form
 * built here reaches someone who can answer it. Never throws, because Pi offers a tool whose
 * `prepareLoadout` throws; a stale extension API after a reload reads as no host.
 */
export function hostServesForms(events: Events): boolean {
  const id = randomUUID();
  let serves = false;
  let off: (() => void) | undefined;
  try {
    off = events.on("tengi:capabilities", (data) => {
      if (!isRecord(data) || data.id !== id || data.v !== 1) return;
      serves ||= data.forms === true && data.formRequests === true;
    });
    events.emit("tengi:capabilities?", { id });
  } catch {
    return false;
  } finally {
    off?.();
  }
  return serves;
}

export interface FormRequest {
  toolCallId: string;
  message: string;
  /** An ACP form schema in the agentui v1 shape, which the host passes on to the client. */
  requestedSchema: object;
}

interface FormReply {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  /** The host was cancelling the turn when the form settled, whatever the client answered. */
  cancelling: boolean;
  /** The host refused the request; what it said. */
  error?: string;
}

export type Asked =
  | { kind: "answered"; reply: FormReply }
  /** No host took the request inside the emit, or the bus refused it; `why` says which. */
  | { kind: "unanswered"; why: string }
  /** The signal aborted before any reply; a reply after that is dropped. */
  | { kind: "aborted" };

// What the host hands back is unchecked until here; an unknown action reads as a cancel
function readReply(data: unknown): FormReply {
  const r = isRecord(data) ? data : {};
  const action =
    r.action === "accept" || r.action === "decline" ? r.action : "cancel";
  return {
    action,
    ...(isRecord(r.content) ? { content: r.content } : {}),
    cancelling: r.cancelling === true,
    ...(typeof r.error === "string" ? { error: r.error } : {}),
  };
}

/** Hands a form to the host and waits for the client's answer, the signal, or neither taking it. */
export function askHost(
  events: Events,
  request: FormRequest,
  signal: AbortSignal | undefined,
): Promise<Asked> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish({ kind: "aborted" });
    const finish = (asked: Asked) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(asked);
    };
    // Listening before the emit: an abort during it, or one the host answers from its own
    // listener, must still read as aborted
    signal?.addEventListener("abort", onAbort, { once: true });
    let acked = false;
    try {
      events.emit("tengi:form?", {
        id: randomUUID(),
        ...request,
        signal: signal ?? new AbortController().signal,
        ack: () => {
          acked = true;
        },
        respond: (reply: unknown) =>
          finish({ kind: "answered", reply: readReply(reply) }),
      });
    } catch (error: unknown) {
      const why = error instanceof Error ? error.message : String(error);
      return finish({ kind: "unanswered", why: `the bus refused it: ${why}` });
    }
    if (!acked) finish({ kind: "unanswered", why: "no host took the form" });
  });
}
