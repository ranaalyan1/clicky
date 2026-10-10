import type { ClickyPublicState, SupportedClaudeModel } from "../shared/contracts";
import { MicrophoneCapture } from "./audio-capture.js";
import { CompanionAudioPlayback } from "./audio-playback.js";

const microphoneCapture = new MicrophoneCapture();
const companionAudioPlayback = new CompanionAudioPlayback();

const statusOrb = requireElement<HTMLElement>("status-orb");
const statusTitle = requireElement<HTMLElement>("status-title");
const statusDescription = requireElement<HTMLElement>("status-description");
const setupCard = requireElement<HTMLElement>("setup-card");
const connectionBadge = requireElement<HTMLElement>("connection-badge");
const workerUrlInput = requireElement<HTMLInputElement>("worker-url");
const saveWorkerButton = requireElement<HTMLButtonElement>("save-worker-button");
const testWorkerButton = requireElement<HTMLButtonElement>("test-worker-button");
const connectionResult = requireElement<HTMLElement>("connection-result");
const pushToTalkButton = requireElement<HTMLButtonElement>("push-to-talk-button");
const activityCard = requireElement<HTMLElement>("activity-card");
const transcriptLabel = requireElement<HTMLElement>("transcript-label");
const activityText = requireElement<HTMLElement>("activity-text");
const errorMessage = requireElement<HTMLElement>("error-message");
const cursorToggle = requireElement<HTMLInputElement>("cursor-toggle");
const launchToggle = requireElement<HTMLInputElement>("launch-toggle");
const sonnetModelButton = requireElement<HTMLButtonElement>("sonnet-model-button");
const opusModelButton = requireElement<HTMLButtonElement>("opus-model-button");
const shortcutStatus = requireElement<HTMLElement>("shortcut-status");
const closeButton = requireElement<HTMLButtonElement>("close-button");

let latestState: ClickyPublicState | null = null;
let panelPushToTalkIsPressed = false;
let hasInitializedWorkerField = false;

function requireElement<ElementType extends HTMLElement>(elementId: string): ElementType {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Missing required panel element #${elementId}`);
  }
  return element as ElementType;
}

function renderState(state: ClickyPublicState): void {
  latestState = state;
  statusOrb.dataset.state = state.voiceState;
  cursorToggle.checked = state.cursorEnabled;
  launchToggle.checked = state.launchAtLogin;
  sonnetModelButton.classList.toggle("active", state.selectedModel === "claude-sonnet-4-6");
  opusModelButton.classList.toggle("active", state.selectedModel === "claude-opus-4-6");

  if (!hasInitializedWorkerField || document.activeElement !== workerUrlInput) {
    workerUrlInput.value = state.workerBaseUrl;
    hasInitializedWorkerField = true;
  }

  setupCard.classList.toggle("connected", state.configured);
  connectionBadge.classList.toggle("connected", state.configured);
  connectionBadge.textContent = state.configured ? "connected" : "not connected";
  pushToTalkButton.disabled = !state.configured;

  const statusMessages: Record<ClickyPublicState["voiceState"], [string, string]> = {
    idle: [
      state.configured ? "ready when you are" : "connect your worker",
      state.configured ? "hold Ctrl + Alt anywhere to talk" : "paste the Worker URL below to get started",
    ],
    listening: ["i'm listening", "release Ctrl + Alt when you're done"],
    processing: ["looking at your screen", "thinking through what you said"],
    responding: ["here's what i found", "press Ctrl + Alt again to interrupt"],
  };
  [statusTitle.textContent, statusDescription.textContent] = statusMessages[state.voiceState];

  const isListening = state.voiceState === "listening";
  pushToTalkButton.classList.toggle("is-pressed", isListening || panelPushToTalkIsPressed);
  pushToTalkButton.querySelector("strong")!.textContent = isListening ? "listening…" : "hold to talk";

  const displayedActivity = state.responseText || state.partialTranscript || state.lastTranscript;
  activityCard.hidden = !displayedActivity;
  if (displayedActivity) {
    transcriptLabel.textContent = state.responseText
      ? "clicky"
      : state.partialTranscript
        ? "hearing"
        : "you said";
    activityText.textContent = displayedActivity;
  }

  errorMessage.hidden = !state.errorMessage;
  errorMessage.textContent = state.errorMessage || "";
  shortcutStatus.classList.toggle("unavailable", !state.shortcutAvailable);
  shortcutStatus.innerHTML = state.shortcutAvailable
    ? "<i></i> global shortcut active"
    : "<i></i> use hold-to-talk button";
}

async function saveWorkerUrl(shouldTestConnection: boolean): Promise<void> {
  const workerBaseUrl = workerUrlInput.value;
  saveWorkerButton.disabled = true;
  testWorkerButton.disabled = true;
  connectionResult.className = "connection-result";
  connectionResult.textContent = shouldTestConnection ? "checking your Worker…" : "saving…";

  try {
    if (shouldTestConnection) {
      const testResult = await window.clicky.testWorker(workerBaseUrl);
      connectionResult.classList.add(testResult.ok ? "success" : "failure");
      connectionResult.textContent = testResult.message;
      const refreshedState = await window.clicky.getState();
      renderState(refreshedState);
    } else {
      const updatedState = await window.clicky.setWorkerUrl(workerBaseUrl);
      renderState(updatedState);
      connectionResult.classList.add("success");
      connectionResult.textContent = "Worker URL saved.";
    }
  } catch (error) {
    connectionResult.classList.add("failure");
    connectionResult.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    saveWorkerButton.disabled = false;
    testWorkerButton.disabled = false;
  }
}

function startPanelPushToTalk(pointerId?: number): void {
  if (panelPushToTalkIsPressed || !latestState?.configured) {
    return;
  }
  panelPushToTalkIsPressed = true;
  pushToTalkButton.classList.add("is-pressed");
  if (pointerId !== undefined) {
    pushToTalkButton.setPointerCapture(pointerId);
  }
  window.clicky.pushToTalkPressed();
}

function stopPanelPushToTalk(): void {
  if (!panelPushToTalkIsPressed) {
    return;
  }
  panelPushToTalkIsPressed = false;
  pushToTalkButton.classList.remove("is-pressed");
  window.clicky.pushToTalkReleased();
}

function setModel(selectedModel: SupportedClaudeModel): void {
  void window.clicky.setModel(selectedModel).then(renderState).catch(showTransientError);
}

function showTransientError(error: unknown): void {
  errorMessage.hidden = false;
  errorMessage.textContent = error instanceof Error ? error.message : String(error);
}

saveWorkerButton.addEventListener("click", () => void saveWorkerUrl(false));
testWorkerButton.addEventListener("click", () => void saveWorkerUrl(true));
workerUrlInput.addEventListener("keydown", (keyboardEvent) => {
  if (keyboardEvent.key === "Enter") {
    void saveWorkerUrl(true);
  }
});

pushToTalkButton.addEventListener("pointerdown", (pointerEvent) => {
  pointerEvent.preventDefault();
  startPanelPushToTalk(pointerEvent.pointerId);
});
pushToTalkButton.addEventListener("pointerup", stopPanelPushToTalk);
pushToTalkButton.addEventListener("pointercancel", stopPanelPushToTalk);
pushToTalkButton.addEventListener("lostpointercapture", stopPanelPushToTalk);
pushToTalkButton.addEventListener("keydown", (keyboardEvent) => {
  if ((keyboardEvent.key === " " || keyboardEvent.key === "Enter") && !keyboardEvent.repeat) {
    keyboardEvent.preventDefault();
    startPanelPushToTalk();
  }
});
pushToTalkButton.addEventListener("keyup", (keyboardEvent) => {
  if (keyboardEvent.key === " " || keyboardEvent.key === "Enter") {
    keyboardEvent.preventDefault();
    stopPanelPushToTalk();
  }
});

cursorToggle.addEventListener("change", () => {
  void window.clicky.setCursorEnabled(cursorToggle.checked).then(renderState).catch(showTransientError);
});
launchToggle.addEventListener("change", () => {
  void window.clicky.setLaunchAtLogin(launchToggle.checked).then(renderState).catch(showTransientError);
});
sonnetModelButton.addEventListener("click", () => setModel("claude-sonnet-4-6"));
opusModelButton.addEventListener("click", () => setModel("claude-opus-4-6"));
closeButton.addEventListener("click", () => window.clicky.hidePanel());

document.addEventListener("contextmenu", (event) => event.preventDefault());
window.addEventListener("blur", () => {
  if (panelPushToTalkIsPressed) {
    stopPanelPushToTalk();
  }
});

window.clicky.onState(renderState);
window.clicky.onAudioCaptureStart(({ interactionId }) => {
  void microphoneCapture.start(interactionId);
});
window.clicky.onAudioCaptureStop(({ interactionId }) => {
  void microphoneCapture.stop(interactionId);
});
window.clicky.onAudioPlayback((payload) => {
  void companionAudioPlayback.playAudio(payload);
});
window.clicky.onFallbackSpeech((payload) => companionAudioPlayback.speakWithWindowsVoice(payload));
window.clicky.onStopAudioPlayback(() => companionAudioPlayback.stop());

void window.clicky.getState().then(renderState).catch(showTransientError);
