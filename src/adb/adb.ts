/**
 * ADB wrapper — the desktop's bridge to a USB/Wi-Fi connected Android device.
 *
 * Locates the `adb` binary, runs commands with a timeout, targets a specific
 * device by serial when needed, and parses `adb devices`. All command handlers
 * go through here so binary resolution + error handling live in one place.
 *
 * Resolution order for the binary:
 *   1. PHONECMD_ADB env var (explicit override)
 *   2. ANDROID_HOME / ANDROID_SDK_ROOT platform-tools
 *   3. `adb` on PATH
 */

import {execFile} from 'child_process';
import {existsSync} from 'fs';
import {join} from 'path';

export interface AdbDevice {
  serial: string;
  state: string; // "device", "unauthorized", "offline", …
}

export class AdbError extends Error {
  constructor(message: string, readonly stderr?: string) {
    super(message);
    this.name = 'AdbError';
  }
}

let cachedBin: string | null = null;

function resolveBin(): string {
  if (cachedBin) {
    return cachedBin;
  }
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb';

  const candidates: string[] = [];
  if (process.env.PHONECMD_ADB) {
    candidates.push(process.env.PHONECMD_ADB);
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (sdk) {
    candidates.push(join(sdk, 'platform-tools', exe));
  }
  for (const c of candidates) {
    if (existsSync(c)) {
      cachedBin = c;
      return c;
    }
  }
  // Fall back to PATH lookup by just using the bare name.
  cachedBin = exe;
  return cachedBin;
}

/** Run an adb invocation. Rejects with AdbError on non-zero exit or timeout.
 *  Pass opts.stdin to feed data to the process's stdin (used by fs.write to
 *  pipe base64 content into `base64 -d` on the device). */
export function adb(
  args: string[],
  opts: {serial?: string; timeoutMs?: number; stdin?: string} = {},
): Promise<string> {
  const bin = resolveBin();
  const full = opts.serial ? ['-s', opts.serial, ...args] : args;

  return new Promise<string>((resolve, reject) => {
    const child = execFile(
      bin,
      full,
      {timeout: opts.timeoutMs ?? 15_000, maxBuffer: 8 * 1024 * 1024},
      (err, stdout, stderr) => {
        if (err) {
          // ENOENT → adb not installed/found.
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
            reject(
              new AdbError(
                'adb binary not found. Install Android platform-tools or set PHONECMD_ADB.',
              ),
            );
            return;
          }
          reject(new AdbError(stderr?.trim() || err.message, stderr));
          return;
        }
        resolve(stdout);
      },
    );
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}

/** Pure parser for `adb devices` output. Exported for testing. */
export function parseDevices(stdout: string): AdbDevice[] {
  return stdout
    .split('\n')
    .slice(1) // drop the "List of devices attached" header
    .map(l => l.trim())
    .filter(Boolean)
    .map(line => {
      const [serial, state] = line.split(/\s+/);
      return {serial, state: state ?? 'unknown'};
    })
    .filter(d => d.serial);
}

/** Parse `adb devices` into a structured list. */
export async function listDevices(): Promise<AdbDevice[]> {
  return parseDevices(await adb(['devices']));
}

/**
 * Pure device-selection logic (no I/O). Given the connected devices and an
 * optional requested serial, return the target serial or throw a clear error.
 * Exported for testing; requireDevice() wraps it with a live device list.
 */
export function selectDevice(devices: AdbDevice[], serial?: string): string {
  const ready = devices.filter(d => d.state === 'device');
  if (ready.length === 0) {
    throw new AdbError(
      'No authorized Android device connected. Plug in a device with USB debugging enabled and accept the prompt.',
    );
  }
  if (serial) {
    if (!ready.some(d => d.serial === serial)) {
      throw new AdbError(`Device ${serial} is not connected or not authorized.`);
    }
    return serial;
  }
  if (ready.length > 1) {
    throw new AdbError(
      `Multiple devices connected (${ready
        .map(d => d.serial)
        .join(', ')}). Specify one with the "serial" arg.`,
    );
  }
  return ready[0].serial;
}

/**
 * Resolve the target device. If a serial is given, validate it; otherwise pick
 * the sole connected device. Throws a clear error for the zero/many cases so the
 * mobile UI can show something actionable.
 */
export async function requireDevice(serial?: string): Promise<string> {
  return selectDevice(await listDevices(), serial);
}

/** Convenience: run `adb shell <cmd…>` against a resolved device. */
export async function shell(
  command: string,
  opts: {serial?: string; timeoutMs?: number} = {},
): Promise<string> {
  const serial = await requireDevice(opts.serial);
  return adb(['shell', command], {serial, timeoutMs: opts.timeoutMs});
}
