import { app, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import { ClickaaController } from "./clickaa-controller";
import { ClickaaConfigStore } from "./config-store";
import { ClickaaDesktopWindows } from "./desktop-windows";
import { GlobalPushToTalkMonitor } from "./global-shortcut-monitor";
import { SupportedClaudeModel } from "../shared/contracts";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let desktopWindows: ClickaaDesktopWindows | null = null;
let clickaaController: ClickaaController | null = null;
let globalPushToTalkMonitor: GlobalPushToTalkMonitor | null = null;
let isQuitting = false;

function registerSecureMediaPermissions(): void {
  session.defaultSession.setPermissionCheckHandler((webContents, permission, _origin, details) => {
    const requestComesFromPanel = webContents !== null
      && desktopWindows?.isPanelWebContents(webContents.id) === true;
    return requestComesFromPanel
      && permission === "media"
      && details.mediaType === "audio";
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestedMediaTypes = ("mediaTypes" in details ? details.mediaTypes : []) ?? [];
    const requestsOnlyAudio = requestedMediaTypes.length > 0
      && requestedMediaTypes.every((mediaType) => mediaType === "audio");
    const requestComesFromPanel = desktopWindows?.isPanelWebContents(webContents.id) === true;
    callback(requestComesFromPanel && permission === "media" && requestsOnlyAudio);
  });
}

function registerIpcHandlers(): void {
  const requirePanelSender = (webContentsId: number): void => {
    if (desktopWindows?.isPanelWebContents(webContentsId) !== true) {
      throw new Error("IPC request rejected: sender is not the Clickaa panel.");
    }
  };
  const panelSentEvent = (webContentsId: number): boolean => {
    return desktopWindows?.isPanelWebContents(webContentsId) === true;
  };

  ipcMain.handle("clickaa:get-state", (event) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.getPublicState();
  });
  ipcMain.handle("clickaa:set-worker-url", (event, workerBaseUrl: string) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.updateWorkerBaseUrl(workerBaseUrl);
  });
  ipcMain.handle("clickaa:test-worker", (event, workerBaseUrl: string) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.testWorkerConnection(workerBaseUrl);
  });
  ipcMain.handle("clickaa:set-model", (event, selectedModel: SupportedClaudeModel) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.updateSelectedModel(selectedModel);
  });
  ipcMain.handle("clickaa:set-cursor-enabled", (event, cursorEnabled: boolean) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.updateCursorEnabled(cursorEnabled);
  });
  ipcMain.handle("clickaa:set-launch-at-login", (event, launchAtLogin: boolean) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.updateLaunchAtLogin(launchAtLogin);
  });

  ipcMain.on("clickaa:panel-hide", (event) => {
    if (panelSentEvent(event.sender.id)) {
      desktopWindows?.hidePanel();
    }
  });
  ipcMain.on("push-to-talk:pressed", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePushToTalkPressed("panelButton");
    }
  });
  ipcMain.on("push-to-talk:released", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePushToTalkReleased();
    }
  });

  ipcMain.on("audio-capture:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handleMicrophoneCaptureStarted(interactionId);
    }
  });
  ipcMain.on(
    "audio-capture:chunk",
    (event, interactionId: number, serializedAudioBytes: unknown) => {
      if (!panelSentEvent(event.sender.id)) {
        return;
      }

      let audioBytes: Uint8Array | null = null;
      if (serializedAudioBytes instanceof ArrayBuffer) {
        audioBytes = new Uint8Array(serializedAudioBytes);
      } else if (ArrayBuffer.isView(serializedAudioBytes)) {
        audioBytes = new Uint8Array(
          serializedAudioBytes.buffer,
          serializedAudioBytes.byteOffset,
          serializedAudioBytes.byteLength,
        );
      }
      if (audioBytes) {
        clickaaController?.appendMicrophoneAudio(interactionId, audioBytes);
      }
    },
  );
  ipcMain.on("audio-capture:level", (event, interactionId: number, audioPowerLevel: number) => {
    if (panelSentEvent(event.sender.id) && Number.isFinite(audioPowerLevel)) {
      clickaaController?.handleAudioPowerLevel(interactionId, audioPowerLevel);
    }
  });
  ipcMain.on("audio-capture:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handleMicrophoneCaptureError(interactionId, String(errorMessage));
    }
  });

  ipcMain.on("audio-playback:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handleAudioPlaybackStarted(interactionId);
    }
  });
  ipcMain.on("audio-playback:ended", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handleAudioPlaybackEnded(interactionId);
    }
  });
  ipcMain.on("audio-playback:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handleAudioPlaybackError(interactionId, String(errorMessage));
    }
  });
  ipcMain.on("overlay:point-complete", (event, interactionId: number) => {
    if (desktopWindows?.isOverlayWebContents(event.sender.id)) {
      clickaaController?.handlePointingAnimationCompleted(interactionId);
    }
  });
}

async function startClickaa(): Promise<void> {
  registerSecureMediaPermissions();

  const configStore = new ClickaaConfigStore(join(app.getPath("userData"), "settings.json"));
  desktopWindows = new ClickaaDesktopWindows({
    onToggleCursor: () => clickaaController?.toggleCursorEnabled(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  clickaaController = new ClickaaController(configStore, desktopWindows);

  registerIpcHandlers();
  await desktopWindows.create();

  globalPushToTalkMonitor = new GlobalPushToTalkMonitor((transition) => {
    if (transition === "pressed") {
      clickaaController?.handlePushToTalkPressed();
    } else {
      clickaaController?.handlePushToTalkReleased();
    }
  });
  const shortcutAvailable = globalPushToTalkMonitor.start();
  clickaaController.start(shortcutAvailable);

  if (!configStore.getConfig().workerBaseUrl) {
    desktopWindows.showPanel();
  }

  screen.on("display-added", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-removed", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-metrics-changed", () => void desktopWindows?.rebuildOverlayWindows());
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(startClickaa);

  app.on("second-instance", () => {
    desktopWindows?.showPanel();
  });

  app.on("window-all-closed", () => {
    // Clickaa is a tray app. Closing its panel must not terminate background PTT.
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalPushToTalkMonitor?.stop();
    clickaaController?.stop();
    desktopWindows?.destroy();
  });

  app.on("activate", () => {
    if (!isQuitting) {
      desktopWindows?.showPanel();
    }
  });
}
