export function convertFloatAudioToPcm16(
  inputSamples: Float32Array,
  inputSampleRate: number,
  outputSampleRate = 16_000,
): Uint8Array {
  if (outputSampleRate > inputSampleRate) {
    throw new Error("The output sample rate cannot exceed the microphone sample rate.");
  }

  const sampleRateRatio = inputSampleRate / outputSampleRate;
  const outputSampleCount = Math.max(1, Math.floor(inputSamples.length / sampleRateRatio));
  const outputBytes = new Uint8Array(outputSampleCount * 2);
  const outputView = new DataView(outputBytes.buffer);

  for (let outputSampleIndex = 0; outputSampleIndex < outputSampleCount; outputSampleIndex += 1) {
    const inputRangeStart = Math.floor(outputSampleIndex * sampleRateRatio);
    const inputRangeEnd = Math.min(
      inputSamples.length,
      Math.max(inputRangeStart + 1, Math.floor((outputSampleIndex + 1) * sampleRateRatio)),
    );

    let accumulatedSample = 0;
    for (let inputSampleIndex = inputRangeStart; inputSampleIndex < inputRangeEnd; inputSampleIndex += 1) {
      accumulatedSample += inputSamples[inputSampleIndex] ?? 0;
    }

    const averagedSample = accumulatedSample / (inputRangeEnd - inputRangeStart);
    const clampedSample = Math.max(-1, Math.min(1, averagedSample));
    const pcmSample = clampedSample < 0
      ? Math.round(clampedSample * 0x8000)
      : Math.round(clampedSample * 0x7fff);
    outputView.setInt16(outputSampleIndex * 2, pcmSample, true);
  }

  return outputBytes;
}

export function calculateAudioPowerLevel(inputSamples: Float32Array): number {
  if (!inputSamples.length) {
    return 0;
  }

  let squaredSampleTotal = 0;
  for (const inputSample of inputSamples) {
    squaredSampleTotal += inputSample * inputSample;
  }
  const rootMeanSquare = Math.sqrt(squaredSampleTotal / inputSamples.length);
  return Math.max(0, Math.min(1, rootMeanSquare * 7));
}

export class MicrophoneCapture {
  private activeInteractionId: number | null = null;
  private mediaStream: MediaStream | null = null;
  private audioContext: AudioContext | null = null;
  private processorNode: ScriptProcessorNode | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private silentOutputNode: GainNode | null = null;

  async start(interactionId: number): Promise<void> {
    await this.stop();
    this.activeInteractionId = interactionId;

    try {
      const mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      if (this.activeInteractionId !== interactionId) {
        mediaStream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        return;
      }

      const audioContext = new AudioContext({ latencyHint: "interactive" });
      const sourceNode = audioContext.createMediaStreamSource(mediaStream);
      const processorNode = audioContext.createScriptProcessor(4096, 1, 1);
      const silentOutputNode = audioContext.createGain();
      silentOutputNode.gain.value = 0;

      processorNode.onaudioprocess = (audioProcessEvent) => {
        if (this.activeInteractionId !== interactionId) {
          return;
        }
        const microphoneSamples = audioProcessEvent.inputBuffer.getChannelData(0);
        const copiedSamples = new Float32Array(microphoneSamples);
        const pcm16Bytes = convertFloatAudioToPcm16(
          copiedSamples,
          audioProcessEvent.inputBuffer.sampleRate,
        );
        window.clicky.sendAudioChunk(interactionId, pcm16Bytes);
        window.clicky.sendAudioPowerLevel(
          interactionId,
          calculateAudioPowerLevel(copiedSamples),
        );
      };

      sourceNode.connect(processorNode);
      processorNode.connect(silentOutputNode);
      silentOutputNode.connect(audioContext.destination);
      if (audioContext.state === "suspended") {
        await audioContext.resume();
      }
      if (this.activeInteractionId !== interactionId) {
        processorNode.onaudioprocess = null;
        processorNode.disconnect();
        sourceNode.disconnect();
        silentOutputNode.disconnect();
        mediaStream.getTracks().forEach((mediaTrack) => mediaTrack.stop());
        await audioContext.close();
        return;
      }

      this.mediaStream = mediaStream;
      this.audioContext = audioContext;
      this.sourceNode = sourceNode;
      this.processorNode = processorNode;
      this.silentOutputNode = silentOutputNode;
      window.clicky.sendAudioCaptureStarted(interactionId);
    } catch (error) {
      if (this.activeInteractionId === interactionId) {
        this.activeInteractionId = null;
        window.clicky.sendAudioCaptureError(
          interactionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  async stop(interactionId?: number): Promise<void> {
    if (interactionId !== undefined && this.activeInteractionId !== interactionId) {
      return;
    }

    this.activeInteractionId = null;
    if (this.processorNode) {
      this.processorNode.onaudioprocess = null;
      this.processorNode.disconnect();
    }
    this.sourceNode?.disconnect();
    this.silentOutputNode?.disconnect();
    this.mediaStream?.getTracks().forEach((mediaTrack) => mediaTrack.stop());

    const audioContext = this.audioContext;
    this.processorNode = null;
    this.sourceNode = null;
    this.silentOutputNode = null;
    this.mediaStream = null;
    this.audioContext = null;

    if (audioContext && audioContext.state !== "closed") {
      await audioContext.close();
    }
  }
}
