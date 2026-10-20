/**
 * Browser-only WebSocket subclass that coerces binary frames to UTF-8 strings
 * before the upstream `onmessage` handler sees them.
 *
 * Why: Some Nostr relays push EVENT/EOSE/NOTICE messages as binary
 * WebSocket frames (Blob or ArrayBuffer) — usually because they're
 * behind a compressing proxy or because they send NIP-42 AUTH challenges
 * in binary mode. nostr-tools v2 (`pool.js#getSubscriptionId`) does
 * `json.slice(0, 22).indexOf('"EVENT"')` without first checking that
 * `json` is a string, and crashes with `TypeError: ...indexOf is not a
 * function` for every binary message. The exception bubbles out of the
 * native `onmessage` handler, which means *every* event from such a
 * relay is silently dropped — the user sees an empty inbox even though
 * messages are arriving.
 *
 * Pass this as `websocketImplementation` to `SimplePool`'s constructor:
 *   ```ts
 *   new SimplePool({ websocketImplementation: TextCoercingWebSocket });
 *   ```
 *
 * Browser-only: relies on the global `WebSocket` and `TextDecoder`. Do
 * not import this from server-side code (Node has its own `ws` package).
 */

// Guard so this file can be imported (and tree-shaken) from contexts
// without a global WebSocket — we throw lazily on construction so the
// module load itself never fails.
const Base: typeof WebSocket =
  typeof WebSocket !== "undefined"
    ? WebSocket
    : (class FakeWebSocket {
        constructor() {
          throw new Error(
            "TextCoercingWebSocket: global WebSocket is not available in this environment",
          );
        }
      } as unknown as typeof WebSocket);

export class TextCoercingWebSocket extends Base {
  constructor(url: string | URL, protocols?: string | string[]) {
    super(url, protocols);
    this.binaryType = "arraybuffer";
  }

  set onmessage(handler: ((ev: MessageEvent) => void) | null) {
    if (!handler) {
      super.onmessage = null;
      return;
    }
    super.onmessage = (ev: MessageEvent) => {
      const data = ev.data;
      if (typeof data === "string") {
        handler(ev);
        return;
      }
      // Coerce binary → text. ArrayBuffer is the common case (binaryType
      // = 'arraybuffer' above guarantees we never get a Blob from frames
      // we initiate), but we keep the Blob branch for safety in case a
      // proxy somewhere downgrades the binaryType.
      try {
        if (data instanceof ArrayBuffer) {
          const text = new TextDecoder("utf-8").decode(data);
          handler(
            new MessageEvent(ev.type, {
              data: text,
              origin: ev.origin,
              lastEventId: ev.lastEventId,
              source: ev.source,
            }),
          );
          return;
        }
        if (typeof Blob !== "undefined" && data instanceof Blob) {
          void data.text().then((text) => {
            handler(
              new MessageEvent(ev.type, {
                data: text,
                origin: ev.origin,
                lastEventId: ev.lastEventId,
                source: ev.source,
              }),
            );
          });
          return;
        }
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("[TextCoercingWebSocket] failed to coerce binary frame:", err);
      }
      // Unknown payload type — let the original handler decide what to
      // do. Safer than dropping a message we don't understand.
      handler(ev);
    };
  }

  get onmessage(): ((ev: MessageEvent) => void) | null {
    return super.onmessage;
  }
}
