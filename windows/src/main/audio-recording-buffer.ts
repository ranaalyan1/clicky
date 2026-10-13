import { encodePcm16ToWav } from "./wav-encoder";

/**
 * Buffers 16 kHz PCM16 microphone audio for the providers that transcribe in
 * one shot after the user releases the shortcut (Gemini).
 */
export class AudioRecordingBuffer {
  private audioChunks: Buffer[] = [];
  private bufferedByteCount = 0;

  constructor(
    private readonly sampleRate = 16_000,
    /** Guard against a stuck shortcut filling memory: 5 minutes of 16 kHz PCM16. */
    private readonly maximumByteCount = 16_000 * 2 * 300,
  ) {}

  append(pcm16Audio: Buffer): void {
    if (!pcm16Audio.length) {
      return;
    }
    if (this.bufferedByteCount + pcm16Audio.length > this.maximumByteCount) {
      return;
    }

    this.audioChunks.push(pcm16Audio);
    this.bufferedByteCount += pcm16Audio.length;
  }

  get durationSeconds(): number {
    return this.bufferedByteCount / (this.sampleRate * 2);
  }

  get isEmpty(): boolean {
    return this.bufferedByteCount === 0;
  }

  toWavBuffer(): Buffer {
    return encodePcm16ToWav(Buffer.concat(this.audioChunks), this.sampleRate);
  }

  clear(): void {
    this.audioChunks = [];
    this.bufferedByteCount = 0;
  }
}

/**
 * Speech longer than this many seconds is transcribed on its own before the
 * cleanup pass, because very long single requests get slow and expensive.
 */
export const maximumSingleShotTranscriptionSeconds = 120;
