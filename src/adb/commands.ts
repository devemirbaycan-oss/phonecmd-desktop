/**
 * ADB-backed command handlers. Each maps a CommandRequest to real device data.
 *
 * Commands (all accept an optional `serial` arg to target a specific device):
 *   adb.devices  → list connected devices
 *   device.info  → model, android version, battery, screen, storage
 *   adb.shell    → run an arbitrary shell command (args.command)
 *   app.list     → installed packages (args.system to include system apps)
 *   app.launch   → launch a package (args.package)
 *   app.stop     → force-stop a package (args.package)
 *   logcat       → bounded logcat snapshot (args.lines, default 200)
 *
 * Handlers throw on failure; the session layer serializes the error back to the
 * phone as { ok:false, error }. adb.ts already produces human-readable messages
 * for the common "no device" / "adb missing" cases.
 */

import {CommandHandler} from '../commands/router';
import {adb, shell, listDevices, requireDevice} from './adb';

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

/** adb.devices — list connected devices and their state. */
export const devicesHandler: CommandHandler = async () => {
  return {devices: await listDevices()};
};

/** device.info — a compact device summary via a few getprop/dumpsys calls. */
export const deviceInfoHandler: CommandHandler = async args => {
  const serial = await requireDevice(str(args?.serial));

  const getprop = async (prop: string) =>
    (await adb(['shell', 'getprop', prop], {serial})).trim();

  const [model, brand, release, sdk, abi] = await Promise.all([
    getprop('ro.product.model'),
    getprop('ro.product.brand'),
    getprop('ro.build.version.release'),
    getprop('ro.build.version.sdk'),
    getprop('ro.product.cpu.abi'),
  ]);

  // Battery level + screen size are best-effort; don't fail the whole call.
  let battery: number | null = null;
  try {
    const dump = await adb(['shell', 'dumpsys', 'battery'], {serial});
    const m = dump.match(/level:\s*(\d+)/);
    battery = m ? Number(m[1]) : null;
  } catch {
    /* ignore */
  }

  let screen: string | null = null;
  try {
    const wm = await adb(['shell', 'wm', 'size'], {serial});
    const m = wm.match(/Physical size:\s*([\dx]+)/);
    screen = m ? m[1] : null;
  } catch {
    /* ignore */
  }

  return {
    serial,
    model,
    brand,
    androidVersion: release,
    sdk: Number(sdk) || sdk,
    abi,
    batteryLevel: battery,
    screen,
  };
};

/** adb.shell — run an arbitrary shell command. args.command is required. */
export const shellHandler: CommandHandler = async args => {
  const command = str(args?.command);
  if (!command) {
    throw new Error('adb.shell requires an "command" string arg');
  }
  const output = await shell(command, {serial: str(args?.serial)});
  return {command, output};
};

/** app.list — installed packages. args.system=true includes system apps. */
export const appListHandler: CommandHandler = async args => {
  const serial = await requireDevice(str(args?.serial));
  const flags = args?.system ? [] : ['-3']; // -3 = third-party only
  const out = await adb(['shell', 'pm', 'list', 'packages', ...flags], {serial});
  const packages = out
    .split('\n')
    .map(l => l.trim().replace(/^package:/, ''))
    .filter(Boolean)
    .sort();
  return {count: packages.length, packages};
};

/** app.launch — launch a package by its main activity. */
export const appLaunchHandler: CommandHandler = async args => {
  const pkg = str(args?.package);
  if (!pkg) {
    throw new Error('app.launch requires a "package" arg');
  }
  const serial = await requireDevice(str(args?.serial));
  const out = await adb(
    ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'],
    {serial},
  );
  return {package: pkg, launched: true, detail: out.trim()};
};

/** app.stop — force-stop a package. */
export const appStopHandler: CommandHandler = async args => {
  const pkg = str(args?.package);
  if (!pkg) {
    throw new Error('app.stop requires a "package" arg');
  }
  const serial = await requireDevice(str(args?.serial));
  await adb(['shell', 'am', 'force-stop', pkg], {serial});
  return {package: pkg, stopped: true};
};

/** logcat — a bounded snapshot (not a live stream, for MVP simplicity). */
export const logcatHandler: CommandHandler = async args => {
  const serial = await requireDevice(str(args?.serial));
  const lines = Math.min(Math.max(Number(args?.lines) || 200, 1), 2000);
  // -d dumps and exits; -t N limits to the last N lines.
  const out = await adb(['logcat', '-d', '-t', String(lines)], {
    serial,
    timeoutMs: 20_000,
  });
  return {lines, log: out};
};

/** Map of command name → handler, for bulk registration on the router. */
export const adbCommands: Record<string, CommandHandler> = {
  'adb.devices': devicesHandler,
  'device.info': deviceInfoHandler,
  'adb.shell': shellHandler,
  'app.list': appListHandler,
  'app.launch': appLaunchHandler,
  'app.stop': appStopHandler,
  logcat: logcatHandler,
};
