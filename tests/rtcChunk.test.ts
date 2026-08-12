/**
 * Data-channel chunking — the split/reassemble round-trip that lets big command
 * responses (e.g. a localhost-preview HTML page) survive the WebRTC channel's
 * ~16 KB max message size. This is why localhost preview worked on LAN/WS but not
 * on P2P until now.
 */
import {describe, it, expect} from 'vitest';
import {splitMessage, ChunkReassembler} from '../src/transport/rtcChunk';

describe('rtc chunking', () => {
  it('passes small messages through unchanged (no framing)', () => {
    const msg = '{"id":"1","command":"echo"}';
    expect(splitMessage(msg)).toEqual([msg]);
    expect(new ChunkReassembler().push(msg)).toBe(msg);
  });

  it('splits a large message and reassembles to the original', () => {
    const big = 'x'.repeat(50000);
    const frames = splitMessage(big);
    expect(frames.length).toBeGreaterThan(1);
    frames.forEach(f => expect(f.length).toBeLessThanOrEqual(12000 + 64)); // slice + header

    const r = new ChunkReassembler();
    let out: string | null = null;
    for (const f of frames) out = r.push(f) ?? out;
    expect(out).toBe(big);
  });

  it('reassembles even if chunks arrive OUT OF ORDER', () => {
    const big = 'abc'.repeat(20000); // 60k
    const frames = splitMessage(big);
    const shuffled = [...frames].reverse();
    const r = new ChunkReassembler();
    let out: string | null = null;
    for (const f of shuffled) out = r.push(f) ?? out;
    expect(out).toBe(big);
  });

  it('preserves payloads that themselves contain the pipe delimiter', () => {
    const big = 'a|b|c|'.repeat(4000); // contains many '|' and is large
    const frames = splitMessage(big);
    const r = new ChunkReassembler();
    let out: string | null = null;
    for (const f of frames) out = r.push(f) ?? out;
    expect(out).toBe(big);
  });

  it('interleaves two concurrent split messages by id without mixing them', () => {
    const a = 'A'.repeat(30000);
    const b = 'B'.repeat(30000);
    const fa = splitMessage(a);
    const fb = splitMessage(b);
    const r = new ChunkReassembler();
    const results: string[] = [];
    // interleave: a0, b0, a1, b1, ...
    const max = Math.max(fa.length, fb.length);
    for (let i = 0; i < max; i++) {
      if (fa[i]) { const o = r.push(fa[i]); if (o) results.push(o); }
      if (fb[i]) { const o = r.push(fb[i]); if (o) results.push(o); }
    }
    expect(results.sort()).toEqual([a, b].sort());
  });
});
