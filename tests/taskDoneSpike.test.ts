/**
 * Tests for the desktop-side task-done detector that drives background
 * notifications. It fires onDone ONCE when a shell finishes a turn (working→
 * settled, confirmed stable after a debounce), re-arms for the next turn, and
 * stays quiet on ordinary output.
 *
 * The primary signal is Codex's braille spinner in the terminal TITLE (OSC 0):
 * "ESC ] 0 ; ⠹ name BEL" while working, "ESC ] 0 ; name BEL" when idle. A text
 * fallback (esc-to-interrupt / done words) covers other CLIs.
 */

import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {TaskDoneSpike} from '../src/terminal/taskDoneSpike';

const OSC = (title: string) => `]0;${title}`;
const WORKING_TITLE = OSC('⠹ EB'); // braille glyph + name → working
const IDLE_TITLE = OSC('EB'); // bare name → settled

describe('TaskDoneSpike (braille-title signal)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires once, after the debounce, on working→settled', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', WORKING_TITLE, done);
    d.feed('t1', IDLE_TITLE, done);
    expect(done).not.toHaveBeenCalled(); // not until the settle is confirmed
    vi.advanceTimersByTime(1600);
    expect(done).toHaveBeenCalledTimes(1);
    // onDone gets a {title, body}: a "… finished" title + a snippet/body.
    const info = done.mock.calls[0][0];
    expect(info.title).toMatch(/finished/);
    expect(typeof info.body).toBe('string');
  });

  it('names the session from the CLI detected in the output', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    // A Codex-flavored idle title (model footer cue) → title says "Codex".
    d.feed('t1', OSC('⠹ codex'), done);
    d.feed('t1', OSC('codex') + '\n  gpt-5.6-terra medium · ~\n', done);
    vi.advanceTimersByTime(1600);
    expect(done.mock.calls[0][0].title).toContain('Codex');
  });

  it('passes a phone-supplied session name through as the title', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', WORKING_TITLE, done, 'Shell 2');
    d.feed('t1', IDLE_TITLE, done, 'Shell 2');
    vi.advanceTimersByTime(1600);
    expect(done.mock.calls[0][0].title).toBe('Shell 2 finished');
  });

  it('does NOT fire without a prior working state', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', IDLE_TITLE, done);
    vi.advanceTimersByTime(2000);
    expect(done).not.toHaveBeenCalled();
  });

  it('collapses a mid-turn spinner pause into ONE notification', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', WORKING_TITLE, done);
    d.feed('t1', IDLE_TITLE, done); // brief pause mid-answer
    vi.advanceTimersByTime(500); // < debounce
    d.feed('t1', WORKING_TITLE, done); // resumes → cancels the pending settle
    d.feed('t1', IDLE_TITLE, done); // real completion
    vi.advanceTimersByTime(1600);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('re-arms after the shell works again', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', WORKING_TITLE, done);
    d.feed('t1', IDLE_TITLE, done);
    vi.advanceTimersByTime(1600);
    d.feed('t1', WORKING_TITLE, done);
    d.feed('t1', IDLE_TITLE, done);
    vi.advanceTimersByTime(1600);
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('does not let plain output between title updates clear working state', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', WORKING_TITLE, done);
    d.feed('t1', 'some streamed answer text with no title update\n', done);
    // Still working (unknown chunk held the state); only a real idle title settles.
    vi.advanceTimersByTime(2000);
    expect(done).not.toHaveBeenCalled();
    d.feed('t1', IDLE_TITLE, done);
    vi.advanceTimersByTime(1600);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('text fallback: esc-to-interrupt → done words (non-title CLI)', () => {
    const d = new TaskDoneSpike();
    const done = vi.fn();
    d.feed('t1', '◦ Working (2s • esc to interrupt)\n', done);
    d.feed('t1', 'all done.\n', done);
    vi.advanceTimersByTime(1600);
    expect(done).toHaveBeenCalledTimes(1);
  });
});
