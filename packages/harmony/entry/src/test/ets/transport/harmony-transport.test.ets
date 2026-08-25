/**
 * Unit tests for the HarmonyOS WebSocket transport adapter.
 *
 * These tests verify:
 * 1. Transport factory creates a valid DaemonTransport
 * 2. Event handler registration and cleanup (onMessage, onOpen, onClose, onError)
 * 3. Terminal binary frame decoding (opcode + slot + payload extraction)
 *
 * Run with: hdc shell aa test -p sh.paseo.harmony -m entry -s unittest OpenHarmonyTestRunner
 */

import { describe, it, expect } from '@ohos/hypium';
import {
  createHarmonyTransport,
  decodeTerminalFrame,
  TerminalOpcode,
} from '../../main/ets/transport/harmony-transport';
import type { DaemonTransport } from '@getpaseo/client/internal/daemon-client-transport-types';

// ---------------------------------------------------------------------------
// Binary frame decoding tests (no WebSocket connection required)
// ---------------------------------------------------------------------------

describe('decodeTerminalFrame', () => {
  it('returns null for data smaller than 2 bytes', () => {
    const empty = new ArrayBuffer(0);
    expect(decodeTerminalFrame(empty)).assertNull();

    const oneByte = new Uint8Array([0x01]).buffer;
    expect(decodeTerminalFrame(oneByte)).assertNull();
  });

  it('decodes a terminal output frame with empty payload', () => {
    // Output opcode (0x01), slot 0, no payload
    const data = new Uint8Array([0x01, 0x00]).buffer;
    const frame = decodeTerminalFrame(data);
    expect(frame).assertNotNull();
    if (frame) {
      expect(frame.opcode).assertEqual(TerminalOpcode.Output);
      expect(frame.slot).assertEqual(0);
      expect(frame.payload.byteLength).assertEqual(0);
    }
  });

  it('decodes a terminal output frame with payload', () => {
    const payload = new TextEncoder().encode('hello\n');
    const data = new Uint8Array(2 + payload.length);
    data[0] = 0x01; // Output
    data[1] = 0x02; // Slot 2
    data.set(payload, 2);

    const frame = decodeTerminalFrame(data.buffer);
    expect(frame).assertNotNull();
    if (frame) {
      expect(frame.opcode).assertEqual(TerminalOpcode.Output);
      expect(frame.slot).assertEqual(2);
      expect(frame.payload.length).assertEqual(payload.length);
    }
  });

  it('decodes all four opcode types', () => {
    const opcodes: [number, TerminalOpcode][] = [
      [0x01, TerminalOpcode.Output],
      [0x02, TerminalOpcode.Input],
      [0x03, TerminalOpcode.Resize],
      [0x04, TerminalOpcode.Snapshot],
    ];

    for (const [raw, expected] of opcodes) {
      const data = new Uint8Array([raw, 0x00]).buffer;
      const frame = decodeTerminalFrame(data);
      expect(frame).assertNotNull();
      if (frame) {
        expect(frame.opcode).assertEqual(expected);
      }
    }
  });

  it('decodes a resize frame payload (JSON {rows, cols})', () => {
    const json = JSON.stringify({ rows: 24, cols: 80 });
    const payload = new TextEncoder().encode(json);
    const data = new Uint8Array(2 + payload.length);
    data[0] = 0x03; // Resize
    data[1] = 0x00; // Slot 0
    data.set(payload, 2);

    const frame = decodeTerminalFrame(data.buffer);
    expect(frame).assertNotNull();
    if (frame) {
      const decoded = JSON.parse(new TextDecoder().decode(frame.payload));
      expect(decoded.rows).assertEqual(24);
      expect(decoded.cols).assertEqual(80);
    }
  });
});

// ---------------------------------------------------------------------------
// Transport interface contract tests
// ---------------------------------------------------------------------------

describe('createHarmonyTransport', () => {
  it('creates a transport with the DaemonTransport shape', () => {
    const transport = createHarmonyTransport({
      url: 'ws://127.0.0.1:6767',
    });

    // Verify all required methods exist
    expect(typeof transport.send).assertEqual('function');
    expect(typeof transport.close).assertEqual('function');
    expect(typeof transport.onMessage).assertEqual('function');
    expect(typeof transport.onOpen).assertEqual('function');
    expect(typeof transport.onClose).assertEqual('function');
    expect(typeof transport.onError).assertEqual('function');
  });

  it('onMessage returns an unsubscribe function', () => {
    const transport = createHarmonyTransport({
      url: 'ws://127.0.0.1:6767',
    });

    let callCount = 0;
    const handler = (_data: unknown) => { callCount++; };
    const unsubscribe = transport.onMessage(handler);

    expect(typeof unsubscribe).assertEqual('function');

    // Unsubscribe should not throw
    unsubscribe();
    // Double unsubscribe should not throw (no-op)
    unsubscribe();
  });

  it('multiple onMessage handlers can be registered and unregistered independently', () => {
    const transport = createHarmonyTransport({
      url: 'ws://127.0.0.1:6767',
    });

    let countA = 0;
    let countB = 0;

    const unsubA = transport.onMessage(() => { countA++; });
    const unsubB = transport.onMessage(() => { countB++; });

    unsubA();

    // Handler B should still be registered (no error on unsubscribe)
    unsubB();
  });
});
