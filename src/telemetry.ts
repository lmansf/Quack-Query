import type { TelemetryEvent } from "../shared/types";

/** URL-safe base64 alphabet: 64 symbols, so `byte & 63` picks one uniformly. */
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const ID_LENGTH = 22; // 132 random bits

/** A random id for one response, matching EVENT_ID_PATTERN; feedback events reference it. */
export function newResponseId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(ID_LENGTH));
  let id = "";
  for (const byte of bytes) id += ID_ALPHABET[byte & 63];
  return id;
}

/**
 * Posts one event to /api/event without waiting for the reply. Never throws and never
 * shows anything: metrics must not get in the way of the app. `keepalive` lets an event
 * sent just before the tab closes still go out.
 */
export function sendEvent(event: TelemetryEvent): void {
  try {
    void fetch("/api/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
      keepalive: true,
    }).catch(() => {
      // Offline, blocked, or the endpoint failed: drop the event.
    });
  } catch {
    // fetch itself threw synchronously (e.g. unavailable): drop the event.
  }
}
