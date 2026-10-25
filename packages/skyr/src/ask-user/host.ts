/**
 * ask_user's form request over the `tengi:` event-bus contract. The request carries its own
 * abort signal and reply callbacks, so no later reply has to cross the bus, where a reload would
 * drop this extension's listeners.
 */
import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../tengi.js";

type Events = ExtensionAPI["events"];

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

export type FormOutcome =
  | { kind: "replied"; reply: FormReply }
  /** No host took the request inside the emit, or the bus refused it; `why` says which. */
  | { kind: "untaken"; why: string }
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
): Promise<FormOutcome> {
  if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
  return new Promise((resolve) => {
    let settled = false;
    const onAbort = () => finish({ kind: "aborted" });
    const finish = (outcome: FormOutcome) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
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
          finish({ kind: "replied", reply: readReply(reply) }),
      });
    } catch (error: unknown) {
      const why = error instanceof Error ? error.message : String(error);
      return finish({ kind: "untaken", why: `the bus refused it: ${why}` });
    }
    if (!acked) finish({ kind: "untaken", why: "no host took the form" });
  });
}
