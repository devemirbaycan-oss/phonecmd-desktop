import {defineConfig} from 'vitest/config';
import {createRequire} from 'module';

const require = createRequire(import.meta.url);

export default defineConfig({
  test: {
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
