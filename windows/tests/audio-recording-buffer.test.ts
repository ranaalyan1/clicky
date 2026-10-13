import assert from "node:assert/strict";
import test from "node:test";
import { AudioRecordingBuffer } from "../src/main/audio-recording-buffer";
import { encodePcm16ToWav } from "../src/main/wav-encoder";

test("appended microphone audio becomes a playable wav header plus samples", () => {
  const recordingBuffer = new AudioRecordingBuffer(16_000);
  assert.equal(recordingBuffer.isEmpty, true);

  // One second of 16 kHz PCM16 mono audio.
  recordingBuffer.append(Buffer.alloc(32_000, 1));

  assert.equal(recordingBuffer.isEmpty, false);
  assert.equal(recordingBuffer.durationSeconds, 1);

  const wavBuffer = recordingBuffer.toWavBuffer();
  assert.equal(wavBuffer.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(wavBuffer.subarray(8, 12).toString("ascii"), "WAVE");
  assert.equal(wavBuffer.length, 44 + 32_000);
});

test("empty chunks are ignored and clearing empties the recording", () => {
  const recordingBuffer = new AudioRecordingBuffer(16_000);
  recordingBuffer.append(Buffer.alloc(0));
  assert.equal(recordingBuffer.isEmpty, true);

  recordingBuffer.append(Buffer.alloc(3_200, 0));
  recordingBuffer.clear();
  assert.equal(recordingBuffer.isEmpty, true);
  assert.equal(recordingBuffer.durationSeconds, 0);
});

test("a stuck shortcut cannot grow the recording past its cap", () => {
  const recordingBuffer = new AudioRecordingBuffer(16_000, 64);
  recordingBuffer.append(Buffer.alloc(64, 0));
  recordingBuffer.append(Buffer.alloc(64, 0));

  assert.equal(recordingBuffer.toWavBuffer().length, 44 + 64);
});

test("the wav encoder writes the requested sample rate and channel count", () => {
  const wavBuffer = encodePcm16ToWav(Buffer.alloc(8, 0), 24_000, 2);
  assert.equal(wavBuffer.readUInt32LE(24), 24_000);
  assert.equal(wavBuffer.readUInt16LE(22), 2);
  assert.equal(wavBuffer.readUInt16LE(34), 16);
  assert.equal(wavBuffer.readUInt32LE(40), 8);
});
