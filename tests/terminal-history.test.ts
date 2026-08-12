/**
 * term.historyClear test — the phone's "Clear" button wipes the PC-stored
 * history. We seed the history file, confirm loadHistory() reads it back, clear
 * it, and confirm it comes back empty. The file lives under ~/.phonecmd, so we
 * assert via the public load/clear API rather than a hardcoded path.
 */

import {describe, it, expect} from 'vitest';
import {appendFileSync, mkdirSync} from 'fs';
import {join} from 'path';
import {homedir} from 'os';
import {loadHistory, clearHistory} from '../src/terminal/terminal';

const DIR = join(homedir(), '.phonecmd');
const HISTORY_FILE = join(DIR, 'history.log');

describe('term.historyClear', () => {
  it('clearHistory() empties what loadHistory() returns', async () => {
    // Seed a couple of entries in the same tab-delimited format the host writes.
    mkdirSync(DIR, {recursive: true});
    appendFileSync(HISTORY_FILE, `${Date.now()}\tgit status\n`);
    appendFileSync(HISTORY_FILE, `${Date.now()}\tnpm test\n`);

    const before = await loadHistory(500);
    expect(before).toContain('git status');
    expect(before).toContain('npm test');

    await clearHistory();

    const after = await loadHistory(500);
    expect(after).toEqual([]);
  });
});
