import type { AudioPlaybackPayload, FallbackSpeechPayload } from "../shared/contracts";

export class CompanionAudioPlayback {
  private activeAudioElement: HTMLAudioElement | null = null;
  private activeSpeechUtterance: SpeechSynthesisUtterance | null = null;
  private activeInteractionId: number | null = null;

  async playAudio(payload: AudioPlaybackPayload): Promise<void> {
    this.stop();
    this.activeInteractionId = payload.interactionId;

    const audioElement = new Audio(
      `data:${payload.contentType};base64,${payload.audioBase64}`,
    );
    this.activeAudioElement = audioElement;

    audioElement.addEventListener("playing", () => {
      if (this.activeInteractionId === payload.interactionId) {
        window.clickaa.sendAudioPlaybackStarted(payload.interactionId);
      }
    }, { once: true });
    audioElement.addEventListener("ended", () => {
      if (this.activeInteractionId === payload.interactionId) {
        this.clearActivePlayback();
        window.clickaa.sendAudioPlaybackEnded(payload.interactionId);
      }
    }, { once: true });
    audioElement.addEventListener("error", () => {
      if (this.activeInteractionId === payload.interactionId) {
        const mediaErrorMessage = audioElement.error?.message || "Windows could not decode the speech audio.";
        this.clearActivePlayback();
        window.clickaa.sendAudioPlaybackError(payload.interactionId, mediaErrorMessage);
      }
    }, { once: true });

    try {
      await audioElement.play();
    } catch (error) {
      if (this.activeInteractionId === payload.interactionId) {
        this.clearActivePlayback();
        window.clickaa.sendAudioPlaybackError(
          payload.interactionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  speakWithWindowsVoice(payload: FallbackSpeechPayload, speechRate = 1.04): void {
    this.stop();
    this.activeInteractionId = payload.interactionId;

    const speechUtterance = new SpeechSynthesisUtterance(payload.text);
    speechUtterance.rate = speechRate;
    speechUtterance.pitch = 1.02;
    this.activeSpeechUtterance = speechUtterance;

    speechUtterance.onstart = () => {
      if (this.activeInteractionId === payload.interactionId) {
        window.clickaa.sendAudioPlaybackStarted(payload.interactionId);
      }
    };
    speechUtterance.onend = () => {
      if (this.activeInteractionId === payload.interactionId) {
        this.clearActivePlayback();
        window.clickaa.sendAudioPlaybackEnded(payload.interactionId);
      }
    };
    speechUtterance.onerror = (speechErrorEvent) => {
      if (this.activeInteractionId === payload.interactionId) {
        this.clearActivePlayback();
        window.clickaa.sendAudioPlaybackError(payload.interactionId, speechErrorEvent.error);
      }
    };

    window.speechSynthesis.speak(speechUtterance);
  }

  stop(): void {
    const activeAudioElement = this.activeAudioElement;
    const activeSpeechUtterance = this.activeSpeechUtterance;
    this.clearActivePlayback();
    if (activeAudioElement) {
      activeAudioElement.pause();
      activeAudioElement.removeAttribute("src");
      activeAudioElement.load();
    }
    if (activeSpeechUtterance) {
      window.speechSynthesis.cancel();
    }
  }

  private clearActivePlayback(): void {
    this.activeInteractionId = null;
    this.activeAudioElement = null;
    this.activeSpeechUtterance = null;
  }
}
