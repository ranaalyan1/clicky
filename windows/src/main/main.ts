import { app, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import { ClickyController } from "./clicky-controller";
import { ClickyConfigStore } from "./config-store";
import { ClickyDesktopWindows } from "./desktop-windows";
import { GlobalPushToTalkMonitor } from "./global-shortcut-monitor";
import { SupportedClaudeModel } from "../shared/contracts";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let desktopWindows: ClickyDesktopWindows | null = null;
let clickyController: ClickyController | null = null;
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
      throw new Error("IPC request rejected: sender is not the Clicky panel.");
    }
  };
  const panelSentEvent = (webContentsId: number): boolean => {
    return desktopWindows?.isPanelWebContents(webContentsId) === true;
  };

  ipcMain.handle("clicky:get-state", (event) => {
    requirePanelSender(event.sender.id);
    return clickyController?.getPublicState();
  });
  ipcMain.handle("clicky:set-worker-url", (event, workerBaseUrl: string) => {
    requirePanelSender(event.sender.id);
    return clickyController?.updateWorkerBaseUrl(workerBaseUrl);
  });
  ipcMain.handle("clicky:test-worker", (event, workerBaseUrl: string) => {
    requirePanelSender(event.sender.id);
    return clickyController?.testWorkerConnection(workerBaseUrl);
  });
  ipcMain.handle("clicky:set-model", (event, selectedModel: SupportedClaudeModel) => {
    requirePanelSender(event.sender.id);
    return clickyController?.updateSelectedModel(selectedModel);
  });
  ipcMain.handle("clicky:set-cursor-enabled", (event, cursorEnabled: boolean) => {
    requirePanelSender(event.sender.id);
    return clickyController?.updateCursorEnabled(cursorEnabled);
  });
  ipcMain.handle("clicky:set-launch-at-login", (event, launchAtLogin: boolean) => {
    requirePanelSender(event.sender.id);
    return clickyController?.updateLaunchAtLogin(launchAtLogin);
  });

  ipcMain.on("clicky:panel-hide", (event) => {
    if (panelSentEvent(event.sender.id)) {
      desktopWindows?.hidePanel();
    }
  });
  ipcMain.on("push-to-talk:pressed", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handlePushToTalkPressed("panelButton");
    }
  });
  ipcMain.on("push-to-talk:released", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handlePushToTalkReleased();
    }
  });

  ipcMain.on("audio-capture:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handleMicrophoneCaptureStarted(interactionId);
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
        clickyController?.appendMicrophoneAudio(interactionId, audioBytes);
      }
    },
  );
  ipcMain.on("audio-capture:level", (event, interactionId: number, audioPowerLevel: number) => {
    if (panelSentEvent(event.sender.id) && Number.isFinite(audioPowerLevel)) {
      clickyController?.handleAudioPowerLevel(interactionId, audioPowerLevel);
    }
  });
  ipcMain.on("audio-capture:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handleMicrophoneCaptureError(interactionId, String(errorMessage));
    }
  });

  ipcMain.on("audio-playback:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handleAudioPlaybackStarted(interactionId);
    }
  });
  ipcMain.on("audio-playback:ended", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handleAudioPlaybackEnded(interactionId);
    }
  });
  ipcMain.on("audio-playback:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickyController?.handleAudioPlaybackError(interactionId, String(errorMessage));
    }
  });
  ipcMain.on("overlay:point-complete", (event, interactionId: number) => {
    if (desktopWindows?.isOverlayWebContents(event.sender.id)) {
      clickyController?.handlePointingAnimationCompleted(interactionId);
    }
  });
}

async function startClicky(): Promise<void> {
  registerSecureMediaPermissions();

  const configStore = new ClickyConfigStore(join(app.getPath("userData"), "settings.json"));
  desktopWindows = new ClickyDesktopWindows({
    onToggleCursor: () => clickyController?.toggleCursorEnabled(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  clickyController = new ClickyController(configStore, desktopWindows);

  registerIpcHandlers();
  await desktopWindows.create();

  globalPushToTalkMonitor = new GlobalPushToTalkMonitor((transition) => {
    if (transition === "pressed") {
      clickyController?.handlePushToTalkPressed();
    } else {
      clickyController?.handlePushToTalkReleased();
    }
  });
  const shortcutAvailable = globalPushToTalkMonitor.start();
  clickyController.start(shortcutAvailable);

  if (!configStore.getConfig().workerBaseUrl) {
    desktopWindows.showPanel();
  }

  screen.on("display-added", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-removed", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-metrics-changed", () => void desktopWindows?.rebuildOverlayWindows());
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(startClicky);

  app.on("second-instance", () => {
    desktopWindows?.showPanel();
  });

  app.on("window-all-closed", () => {
    // Clicky is a tray app. Closing its panel must not terminate background PTT.
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalPushToTalkMonitor?.stop();
    clickyController?.stop();
    desktopWindows?.destroy();
  });

  app.on("activate", () => {
    if (!isQuitting) {
      desktopWindows?.showPanel();
    }
  });
}
