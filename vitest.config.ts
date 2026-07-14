import {defineConfig} from 'vitest/config';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
    // Isolate each test file in its own forked process. terminal-pty.test.ts
    // spawns a REAL PTY (node-pty), which mutates process-wide console state —
    // on Windows that surfaced as "AttachConsole failed" and made session.test.ts
    // fail, but only when the two ran in the same worker. Per-file processes
    // stop that cross-contamination; it also fixed a nondeterministic CI failure.
    pool: 'forks',
    poolOptions: {forks: {isolate: true}},
    fileParallelism: false, // a spawned shell + parallel files is a flaky combo
    // Point the host's on-disk state (~/.phonecmd) at a temp dir, so a test run
    // can never clobber the developer's real identity / paired-device list.
    setupFiles: ['./tests/setup.ts'],
    // libsodium-wrappers ships a broken ESM build (its modules-esm entry
    // imports a .mjs that isn't published). Force the CommonJS build, which is
    // what Node/Electron use at runtime anyway, so tests exercise the same code.
    server: {
      deps: {
        inline: ['libsodium-wrappers', 'libsodium-wrappers-sumo'],
      },
    },
  },
  resolve: {
    alias: {
      'libsodium-wrappers': require.resolve('libsodium-wrappers'),
    },
  },
});
