import { app, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import { ClickaaConfigStore } from "./config-store";
import { ClickaaController } from "./clickaa-controller";
import { ClickaaDesktopWindows } from "./desktop-windows";
import { GlobalShortcutMonitor } from "./global-shortcut-monitor";
import { migrateLegacyClickyUserData } from "./legacy-migration";
import { ClickaaUserConfig, IslandToggleKey } from "../shared/contracts";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/** The walkthrough Clickaa points people at from the setup tab. */
const setupVideoUrl = "https://youtu.be/bei_Cc8-CBw";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let desktopWindows: ClickaaDesktopWindows | null = null;
let clickaaController: ClickaaController | null = null;
let globalShortcutMonitor: GlobalShortcutMonitor | null = null;
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
  const islandSentEvent = (webContentsId: number): boolean => {
    return desktopWindows?.isIslandWebContents(webContentsId) === true;
  };

  /* Panel: state and settings -------------------------------------------- */

  ipcMain.handle("clickaa:get-state", (event) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.getPublicState();
  });
  ipcMain.handle("clickaa:update-settings", (event, settingsUpdates: Partial<ClickaaUserConfig>) => {
    requirePanelSender(event.sender.id);
    const updatedState = clickaaController?.updateSettings(settingsUpdates);
    // Changing the dictation shortcut rebuilds the global key state machine.
    if (settingsUpdates && typeof settingsUpdates === "object" && "dictationShortcut" in settingsUpdates) {
      globalShortcutMonitor?.setDictationShortcut(updatedState?.config.dictationShortcut ?? "ctrl+windows");
    }
    return updatedState;
  });
  ipcMain.handle("clickaa:test-brain", (event, settingsUpdates: Partial<ClickaaUserConfig>) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.testBrainConnection(settingsUpdates);
  });
  ipcMain.on("clickaa:open-setup-video", (event) => {
    if (panelSentEvent(event.sender.id)) {
      void import("electron").then(({ shell }) => shell.openExternal(setupVideoUrl));
    }
  });
  ipcMain.handle("clickaa:refresh-app-index", (event) => {
    requirePanelSender(event.sender.id);
    return clickaaController?.refreshAppIndex();
  });

  /* Panel: push-to-talk --------------------------------------------------- */

  ipcMain.on("clickaa:panel-hide", (event) => {
    if (panelSentEvent(event.sender.id)) {
      desktopWindows?.hidePanel();
    }
  });
  ipcMain.on("push-to-talk:pressed", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePanelPushToTalkPressed();
    }
  });
  ipcMain.on("push-to-talk:released", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePanelPushToTalkReleased();
    }
  });

  /* Panel: microphone and playback --------------------------------------- */

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

  /* Overlay --------------------------------------------------------------- */

  ipcMain.on("overlay:point-complete", (event, interactionId: number) => {
    if (desktopWindows?.isOverlayWebContents(event.sender.id)) {
      clickaaController?.handlePointingAnimationCompleted(interactionId);
    }
  });

  /* Island ---------------------------------------------------------------- */

  ipcMain.handle("island:get-state", (event) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.getIslandState();
  });
  ipcMain.on("island:pointer-over", (event, isPointerOverIsland: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      desktopWindows?.setIslandInteractionEnabled(Boolean(isPointerOverIsland));
    }
  });
  ipcMain.on("island:close", (event) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandClosedByUser();
    }
  });
  ipcMain.on("island:set-expanded", (event, isExpanded: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandExpandedChanged(Boolean(isExpanded));
    }
  });
  ipcMain.handle("island:resolve-confirmation", (event, confirmationId: string, decision: "approve" | "reject") => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.runConfirmationDecision(confirmationId, decision);
  });
  ipcMain.handle("island:undo-activity", (event, activityEntryId: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.undoActivity(activityEntryId);
  });
  ipcMain.handle("island:launch-app", (event, appName: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.handleIslandLaunchApp(appName);
  });
  ipcMain.handle("island:media-control", (event, operation: "play_pause" | "next" | "previous") => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.handleIslandMediaControl(operation);
  });
  ipcMain.handle("island:copy-clip", (event, clipId: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.handleIslandClipboardCopy(clipId);
  });
  ipcMain.on("island:clear-clips", (event) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandClipboardClear();
    }
  });
  ipcMain.on("island:toggle-todo", (event, todoId: string, isDone: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandTodoToggle(todoId, Boolean(isDone));
    }
  });
  ipcMain.on("island:remove-todo", (event, todoId: string) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandTodoRemove(todoId);
    }
  });
  ipcMain.on("island:toggle-schedule", (event, scheduleId: string, isEnabled: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandScheduleToggle(scheduleId, Boolean(isEnabled));
    }
  });
  ipcMain.on("island:remove-schedule", (event, scheduleId: string) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandScheduleRemove(scheduleId);
    }
  });
  ipcMain.on("island:remove-memory", (event, memoryFactId: string) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandMemoryRemove(memoryFactId);
    }
  });
  ipcMain.on("panel:add-todo", (event, todoText: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePanelTodoAdd(String(todoText));
    }
  });
  ipcMain.on("panel:add-memory", (event, factText: string) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePanelMemoryAdd(String(factText));
    }
  });
  ipcMain.on("panel:clear-memory", (event) => {
    if (panelSentEvent(event.sender.id)) {
      clickaaController?.handlePanelMemoryClear();
    }
  });

  ipcMain.on("island:open-panel", (event, page: string) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandOpenPanel(String(page));
    }
  });
  ipcMain.on("island:set-toggle", (event, toggleKey: string, isEnabled: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      clickaaController?.handleIslandToggle(toggleKey as IslandToggleKey, Boolean(isEnabled));
    }
  });
  ipcMain.handle("island:set-wallpaper-solid", (event, wallpaperColor: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Clickaa island.");
    }
    return clickaaController?.handleIslandWallpaperSolidColor(String(wallpaperColor));
  });

  /* Panel: page switching asked for by the island or the panel itself ------ */

  ipcMain.on("panel:open-page", (event, page: string) => {
    if (panelSentEvent(event.sender.id) || islandSentEvent(event.sender.id)) {
      desktopWindows?.showPanel(String(page) || "home");
    }
  });

  /* Region selector (circle to ask) --------------------------------------- */

  ipcMain.on("selection:completed", (event, selectionBounds: { x: number; y: number; width: number; height: number }) => {
    const selectorRecord = desktopWindows?.getRegionSelectorRecord(event.sender.id) ?? null;
    if (!selectorRecord) {
      return;
    }

    // The renderer draws in display-relative pixels; the capture needs desktop
    // coordinates, which is what the selector window's own bounds provide.
    const desktopRegionSelection = {
      displayId: selectorRecord.displayId,
      x: selectorRecord.bounds.x + selectionBounds.x,
      y: selectorRecord.bounds.y + selectionBounds.y,
      width: selectionBounds.width,
      height: selectionBounds.height,
    };

    desktopWindows?.hideRegionSelector();
    if (selectorRecord.purpose === "snip") {
      void clickaaController?.handleSnipRegionSelected(desktopRegionSelection);
    } else {
      clickaaController?.handleCircleRegionSelected(desktopRegionSelection);
    }
  });
  ipcMain.on("selection:cancelled", (event) => {
    const selectorRecord = desktopWindows?.getRegionSelectorRecord(event.sender.id) ?? null;
    if (selectorRecord) {
      if (selectorRecord.purpose === "snip") {
        clickaaController?.handleSnipCancelled();
      } else {
        clickaaController?.handleCircleSelectionCancelled();
      }
      desktopWindows?.hideRegionSelector();
    }
  });
}

async function startClickaa(): Promise<void> {
  registerSecureMediaPermissions();

  const userDataDirectory = app.getPath("userData");
  migrateLegacyClickyUserData(app.getPath("appData"), userDataDirectory);

  const configStore = new ClickaaConfigStore(join(userDataDirectory, "settings.json"));
  desktopWindows = new ClickaaDesktopWindows({
    onToggleCursor: () => clickaaController?.toggleCursorEnabled(),
    onToggleIsland: () => clickaaController?.toggleIslandEnabled(),
    onToggleAutomationPaused: () => clickaaController?.toggleAutomationPaused(),
    onToggleWakeWordMuted: () => clickaaController?.toggleWakeWordMuted(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  clickaaController = new ClickaaController(configStore, desktopWindows, userDataDirectory);

  registerIpcHandlers();
  await desktopWindows.create();

  globalShortcutMonitor = new GlobalShortcutMonitor(
    configStore.getConfig().dictationShortcut,
    (transition) => {
      if (transition.phase === "pressed") {
        clickaaController?.handleShortcutPressed(transition.shortcutId);
      } else {
        clickaaController?.handleShortcutReleased(transition.shortcutId);
      }
    },
    () => clickaaController?.handleEscapePressed(),
  );
  const shortcutAvailable = globalShortcutMonitor.start();
  await clickaaController.start(shortcutAvailable);

  if (!clickaaController.getPublicState().configured) {
    desktopWindows.showPanel("setup");
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
    // Clickaa is a tray app. Closing its panel must not terminate background work.
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcutMonitor?.stop();
    clickaaController?.stop();
    desktopWindows?.destroy();
  });

  app.on("activate", () => {
    if (!isQuitting) {
      desktopWindows?.showPanel();
    }
  });
}
