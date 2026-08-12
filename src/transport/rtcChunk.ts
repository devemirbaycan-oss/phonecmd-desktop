/**
 * Data-channel message chunking.
 *
 * WebRTC data channels cap a single message at ~16 KB (the negotiated
 * `maxMessageSize`; libwebrtc's practical safe limit). Sending a larger string
 * silently fails/drops — which is why big command responses (e.g. a localhost-
 * preview HTML page, base64-inflated) never arrived over P2P even though small
 * ones (terminal output) did. LAN/WebSocket has no such per-message limit, so it
 * only broke on remote.
 *
 * Fix: frame large payloads into chunks the channel can carry, reassemble on the
 * far side. Small payloads pass through UNCHANGED so this is backward compatible
 * with a peer that doesn't chunk (the frame prefix is only added when needed).
 *
 * Frame format (only for split messages), pipe-delimited fixed fields:
 *   "PCMDCHUNK|<id>|<index>|<total>|<payload>"
 * The command JSON we normally send starts with '{', so it can never be mistaken
 * for a chunk frame, and `id` is generated without pipes.
 */

const PREFIX = 'PCMDCHUNK|';
// Keep well under the 16 KB channel limit, accounting for header + UTF-16.
const MAX_CHUNK = 12000;

let counter = 0;

/** Split `data` into channel-safe frames. Returns [data] unchanged if it fits. */
export function splitMessage(data: string): string[] {
  if (data.length <= MAX_CHUNK) return [data];
  const id = `${Date.now().toString(36)}${(counter++).toString(36)}`;
  const slices: string[] = [];
  for (let i = 0; i < data.length; i += MAX_CHUNK) {
    slices.push(data.slice(i, i + MAX_CHUNK));
  }
  const total = slices.length;
  return slices.map((s, i) => `${PREFIX}${id}|${i}|${total}|${s}`);
}

/**
 * Reassembler — feed it every raw message from the channel. Returns a COMPLETE
 * message string when one is ready (a passthrough small message, or the final
 * chunk of a split one), else null while still collecting.
 */
export class ChunkReassembler {
  private buffers = new Map<string, {parts: string[]; got: number; total: number}>();

  push(raw: string): string | null {
    if (!raw.startsWith(PREFIX)) return raw; // not chunked — pass through
    const rest = raw.slice(PREFIX.length);
    // Split only the first 4 fields; the payload may itself contain '|'.
    const p1 = rest.indexOf('|');
    const p2 = rest.indexOf('|', p1 + 1);
    const p3 = rest.indexOf('|', p2 + 1);
    if (p1 < 0 || p2 < 0 || p3 < 0) return null; // malformed — drop
    const id = rest.slice(0, p1);
    const index = parseInt(rest.slice(p1 + 1, p2), 10);
    const total = parseInt(rest.slice(p2 + 1, p3), 10);
    const payload = rest.slice(p3 + 1);
    if (!Number.isInteger(index) || !Number.isInteger(total) || total < 1) return null;

    let entry = this.buffers.get(id);
    if (!entry) {
      entry = {parts: new Array(total).fill(undefined as unknown as string), got: 0, total};
      this.buffers.set(id, entry);
    }
    if (entry.parts[index] === undefined) {
      entry.parts[index] = payload;
      entry.got++;
    }
    if (entry.got === entry.total) {
      this.buffers.delete(id);
      return entry.parts.join('');
    }
    return null;
  }
}
