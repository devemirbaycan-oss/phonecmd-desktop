/**
 * ADB pure-logic tests — the parsing + device-selection that must be correct
 * without a real device attached.
 */

import {describe, it, expect} from 'vitest';
import {parseDevices, selectDevice, AdbError} from '../src/adb/adb';

describe('parseDevices', () => {
  it('parses an empty device list', () => {
    expect(parseDevices('List of devices attached\n\n')).toEqual([]);
  });

  it('parses connected + unauthorized + offline devices', () => {
    const out = [
      'List of devices attached',
      'ABC123\tdevice',
      'XYZ789\tunauthorized',
      'OLD000\toffline',
      '',
    ].join('\n');
    expect(parseDevices(out)).toEqual([
      {serial: 'ABC123', state: 'device'},
      {serial: 'XYZ789', state: 'unauthorized'},
      {serial: 'OLD000', state: 'offline'},
    ]);
  });

  it('tolerates extra whitespace and trailing daemon lines', () => {
    const out = 'List of devices attached\n  ABC123   device  \n';
    expect(parseDevices(out)).toEqual([{serial: 'ABC123', state: 'device'}]);
  });
});

describe('selectDevice', () => {
  const ready = {serial: 'ABC123', state: 'device'};
  const other = {serial: 'DEF456', state: 'device'};

  it('throws a clear error when nothing is connected', () => {
    expect(() => selectDevice([])).toThrow(AdbError);
    expect(() => selectDevice([{serial: 'X', state: 'unauthorized'}])).toThrow(
      /No authorized Android device/,
    );
  });

  it('returns the sole connected device', () => {
    expect(selectDevice([ready])).toBe('ABC123');
  });

  it('requires a serial when multiple are connected', () => {
    expect(() => selectDevice([ready, other])).toThrow(/Multiple devices/);
  });

  it('honors a valid requested serial', () => {
    expect(selectDevice([ready, other], 'DEF456')).toBe('DEF456');
  });

  it('rejects an unknown requested serial', () => {
    expect(() => selectDevice([ready], 'NOPE')).toThrow(/not connected/);
  });
});
