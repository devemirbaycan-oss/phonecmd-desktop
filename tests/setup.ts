/**
 * Global test setup — runs before every test file.
 *
 * Redirects the host's on-disk state (~/.phonecmd) to a throwaway temp dir.
 * SessionManager persists known devices on a successful pairing, and several
 * test files complete pairings; without this, running the suite would mutate the
 * developer's REAL paired-device list. (It did, once, before this existed.)
 *
 * Doing it here rather than per-file means a new test can't forget to opt in.
 */

import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

const home = mkdtempSync(join(tmpdir(), 'phonecmd-test-home-'));
process.env.PHONECMD_HOME = home;

// Vitest calls this on teardown of the worker.
export function teardown(): void {
  rmSync(home, {recursive: true, force: true});
}
