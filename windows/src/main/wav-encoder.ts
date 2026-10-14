/**
 * WAV encoding for providers that take an audio file rather than a live stream,
 * which is how Gemini transcription is fed.
 */

const wavHeaderByteCount = 44;

export function encodePcm16ToWav(
  pcm16Audio: Buffer,
  sampleRate: number,
  channelCount = 1,
): Buffer {
  const byteRate = sampleRate * channelCount * 2;
  const blockAlign = channelCount * 2;
  const header = Buffer.alloc(wavHeaderByteCount);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm16Audio.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // PCM format chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channelCount, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm16Audio.length, 40);

  return Buffer.concat([header, pcm16Audio]);
}

/**
 * Gemini text-to-speech returns raw 16-bit PCM at 24 kHz, which no HTML audio
 * element can play, so Ustaad wraps it before playback.
 */
export function wrapGeminiSpeechAudio(base64PcmAudio: string, sampleRate = 24_000): {
  audioData: Buffer;
  contentType: string;
} {
  const pcmAudio = Buffer.from(base64PcmAudio, "base64");
  return {
    audioData: encodePcm16ToWav(pcmAudio, sampleRate),
    contentType: "audio/wav",
  };
}
