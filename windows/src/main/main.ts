import { app, ipcMain, screen, session } from "electron";
import { join } from "node:path";
import { UstaadConfigStore } from "./config-store";
import { UstaadController } from "./ustaad-controller";
import { UstaadDesktopWindows } from "./desktop-windows";
import { GlobalShortcutMonitor } from "./global-shortcut-monitor";
import { migrateLegacyUserData } from "./legacy-migration";
import { UstaadUserConfig, IslandToggleKey } from "../shared/contracts";

app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");

/** The walkthrough Ustaad points people at from the setup tab. */
const setupVideoUrl = "https://youtu.be/bei_Cc8-CBw";

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
}

let desktopWindows: UstaadDesktopWindows | null = null;
let ustaadController: UstaadController | null = null;
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
      throw new Error("IPC request rejected: sender is not the Ustaad panel.");
    }
  };
  const panelSentEvent = (webContentsId: number): boolean => {
    return desktopWindows?.isPanelWebContents(webContentsId) === true;
  };
  const islandSentEvent = (webContentsId: number): boolean => {
    return desktopWindows?.isIslandWebContents(webContentsId) === true;
  };

  /* Panel: state and settings -------------------------------------------- */

  ipcMain.handle("ustaad:get-state", (event) => {
    requirePanelSender(event.sender.id);
    return ustaadController?.getPublicState();
  });
  ipcMain.handle("ustaad:update-settings", (event, settingsUpdates: Partial<UstaadUserConfig>) => {
    requirePanelSender(event.sender.id);
    const updatedState = ustaadController?.updateSettings(settingsUpdates);
    // Changing the dictation shortcut rebuilds the global key state machine.
    if (settingsUpdates && typeof settingsUpdates === "object" && "dictationShortcut" in settingsUpdates) {
      globalShortcutMonitor?.setDictationShortcut(updatedState?.config.dictationShortcut ?? "ctrl+windows");
    }
    return updatedState;
  });
  ipcMain.handle("ustaad:test-brain", (event, settingsUpdates: Partial<UstaadUserConfig>) => {
    requirePanelSender(event.sender.id);
    return ustaadController?.testBrainConnection(settingsUpdates);
  });
  ipcMain.on("ustaad:open-setup-video", (event) => {
    if (panelSentEvent(event.sender.id)) {
      void import("electron").then(({ shell }) => shell.openExternal(setupVideoUrl));
    }
  });
  ipcMain.handle("ustaad:refresh-app-index", (event) => {
    requirePanelSender(event.sender.id);
    return ustaadController?.refreshAppIndex();
  });

  /* Panel: push-to-talk --------------------------------------------------- */

  ipcMain.on("ustaad:panel-hide", (event) => {
    if (panelSentEvent(event.sender.id)) {
      desktopWindows?.hidePanel();
    }
  });
  ipcMain.on("push-to-talk:pressed", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handlePanelPushToTalkPressed();
    }
  });
  ipcMain.on("push-to-talk:released", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handlePanelPushToTalkReleased();
    }
  });

  /* Panel: microphone and playback --------------------------------------- */

  ipcMain.on("audio-capture:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handleMicrophoneCaptureStarted(interactionId);
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
        ustaadController?.appendMicrophoneAudio(interactionId, audioBytes);
      }
    },
  );
  ipcMain.on("audio-capture:level", (event, interactionId: number, audioPowerLevel: number) => {
    if (panelSentEvent(event.sender.id) && Number.isFinite(audioPowerLevel)) {
      ustaadController?.handleAudioPowerLevel(interactionId, audioPowerLevel);
    }
  });
  ipcMain.on("audio-capture:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handleMicrophoneCaptureError(interactionId, String(errorMessage));
    }
  });
  ipcMain.on("audio-playback:started", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handleAudioPlaybackStarted(interactionId);
    }
  });
  ipcMain.on("audio-playback:ended", (event, interactionId: number) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handleAudioPlaybackEnded(interactionId);
    }
  });
  ipcMain.on("audio-playback:error", (event, interactionId: number, errorMessage: string) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handleAudioPlaybackError(interactionId, String(errorMessage));
    }
  });

  /* Overlay --------------------------------------------------------------- */

  ipcMain.on("overlay:point-complete", (event, interactionId: number) => {
    if (desktopWindows?.isOverlayWebContents(event.sender.id)) {
      ustaadController?.handlePointingAnimationCompleted(interactionId);
    }
  });

  /* Island ---------------------------------------------------------------- */

  ipcMain.handle("island:get-state", (event) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.getIslandState();
  });
  ipcMain.on("island:pointer-over", (event, isPointerOverIsland: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      desktopWindows?.setIslandInteractionEnabled(Boolean(isPointerOverIsland));
    }
  });
  ipcMain.on("island:close", (event) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandClosedByUser();
    }
  });
  ipcMain.on("island:set-expanded", (event, isExpanded: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandExpandedChanged(Boolean(isExpanded));
    }
  });
  ipcMain.handle("island:resolve-confirmation", (event, confirmationId: string, decision: "approve" | "reject") => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.runConfirmationDecision(confirmationId, decision);
  });
  ipcMain.handle("island:save-skill-suggestion", (event) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    const savedSkill = ustaadController?.saveSuggestedSkill();
    return savedSkill ? `saved the ${savedSkill.name} skill.` : "there was nothing to save.";
  });
  ipcMain.handle("island:dismiss-skill-suggestion", (event) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    ustaadController?.dismissSuggestedSkill();
  });
  ipcMain.handle("panel:rename-skill", (event, skillId: string, nextName: string) => {
    if (!panelSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad panel.");
    }
    ustaadController?.renameSkill(String(skillId), String(nextName));
  });
  ipcMain.handle("panel:remove-skill", (event, skillId: string) => {
    if (!panelSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad panel.");
    }
    ustaadController?.removeSkill(String(skillId));
  });
  ipcMain.handle("panel:run-check-in-now", (event) => {
    if (!panelSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad panel.");
    }
    return ustaadController?.runCheckInNow();
  });
  ipcMain.handle("island:undo-activity", (event, activityEntryId: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.undoActivity(activityEntryId);
  });
  ipcMain.handle("island:launch-app", (event, appName: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.handleIslandLaunchApp(appName);
  });
  ipcMain.handle("island:media-control", (event, operation: "play_pause" | "next" | "previous") => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.handleIslandMediaControl(operation);
  });
  ipcMain.handle("island:copy-clip", (event, clipId: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.handleIslandClipboardCopy(clipId);
  });
  ipcMain.on("island:clear-clips", (event) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandClipboardClear();
    }
  });
  ipcMain.on("island:toggle-todo", (event, todoId: string, isDone: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandTodoToggle(todoId, Boolean(isDone));
    }
  });
  ipcMain.on("island:remove-todo", (event, todoId: string) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandTodoRemove(todoId);
    }
  });
  ipcMain.on("island:toggle-schedule", (event, scheduleId: string, isEnabled: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandScheduleToggle(scheduleId, Boolean(isEnabled));
    }
  });
  ipcMain.on("island:remove-schedule", (event, scheduleId: string) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandScheduleRemove(scheduleId);
    }
  });
  ipcMain.on("island:remove-memory", (event, memoryFactId: string) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandMemoryRemove(memoryFactId);
    }
  });
  ipcMain.on("panel:add-todo", (event, todoText: string) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handlePanelTodoAdd(String(todoText));
    }
  });
  ipcMain.on("panel:add-memory", (event, factText: string) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handlePanelMemoryAdd(String(factText));
    }
  });
  ipcMain.on("panel:clear-audit-log", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.clearAuditLog();
    }
  });

  ipcMain.on("panel:rotate-phone-token", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.rotatePhoneBridgeToken();
    }
  });

  ipcMain.handle("panel:search-run-history", (event, query: string) => {
    if (!panelSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad panel.");
    }
    return ustaadController?.searchRunHistory(String(query)) ?? [];
  });

  ipcMain.on("panel:clear-run-history", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.clearRunHistory();
    }
  });

  ipcMain.on("panel:clear-memory", (event) => {
    if (panelSentEvent(event.sender.id)) {
      ustaadController?.handlePanelMemoryClear();
    }
  });

  ipcMain.on("island:open-panel", (event, page: string) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandOpenPanel(String(page));
    }
  });
  ipcMain.on("island:set-toggle", (event, toggleKey: string, isEnabled: boolean) => {
    if (islandSentEvent(event.sender.id)) {
      ustaadController?.handleIslandToggle(toggleKey as IslandToggleKey, Boolean(isEnabled));
    }
  });
  ipcMain.handle("island:set-wallpaper-solid", (event, wallpaperColor: string) => {
    if (!islandSentEvent(event.sender.id)) {
      throw new Error("IPC request rejected: sender is not the Ustaad island.");
    }
    return ustaadController?.handleIslandWallpaperSolidColor(String(wallpaperColor));
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
      void ustaadController?.handleSnipRegionSelected(desktopRegionSelection);
    } else {
      ustaadController?.handleCircleRegionSelected(desktopRegionSelection);
    }
  });
  ipcMain.on("selection:cancelled", (event) => {
    const selectorRecord = desktopWindows?.getRegionSelectorRecord(event.sender.id) ?? null;
    if (selectorRecord) {
      if (selectorRecord.purpose === "snip") {
        ustaadController?.handleSnipCancelled();
      } else {
        ustaadController?.handleCircleSelectionCancelled();
      }
      desktopWindows?.hideRegionSelector();
    }
  });
}

async function startUstaad(): Promise<void> {
  registerSecureMediaPermissions();

  const userDataDirectory = app.getPath("userData");
  migrateLegacyUserData(app.getPath("appData"), userDataDirectory);

  const configStore = new UstaadConfigStore(join(userDataDirectory, "settings.json"));
  desktopWindows = new UstaadDesktopWindows({
    onToggleCursor: () => ustaadController?.toggleCursorEnabled(),
    onToggleIsland: () => ustaadController?.toggleIslandEnabled(),
    onToggleAutomationPaused: () => ustaadController?.toggleAutomationPaused(),
    onToggleWakeWordMuted: () => ustaadController?.toggleWakeWordMuted(),
    onQuit: () => {
      isQuitting = true;
      app.quit();
    },
  });
  ustaadController = new UstaadController(configStore, desktopWindows, userDataDirectory);

  registerIpcHandlers();
  await desktopWindows.create();

  globalShortcutMonitor = new GlobalShortcutMonitor(
    configStore.getConfig().dictationShortcut,
    (transition) => {
      if (transition.phase === "pressed") {
        ustaadController?.handleShortcutPressed(transition.shortcutId);
      } else {
        ustaadController?.handleShortcutReleased(transition.shortcutId);
      }
    },
    () => ustaadController?.handleEscapePressed(),
  );
  const shortcutAvailable = globalShortcutMonitor.start();
  await ustaadController.start(shortcutAvailable);

  if (!ustaadController.getPublicState().configured) {
    desktopWindows.showPanel("setup");
  }

  screen.on("display-added", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-removed", () => void desktopWindows?.rebuildOverlayWindows());
  screen.on("display-metrics-changed", () => void desktopWindows?.rebuildOverlayWindows());
}

if (hasSingleInstanceLock) {
  void app.whenReady().then(startUstaad);

  app.on("second-instance", () => {
    desktopWindows?.showPanel();
  });

  app.on("window-all-closed", () => {
    // Ustaad is a tray app. Closing its panel must not terminate background work.
  });

  app.on("before-quit", () => {
    isQuitting = true;
    globalShortcutMonitor?.stop();
    ustaadController?.stop();
    desktopWindows?.destroy();
  });

  app.on("activate", () => {
    if (!isQuitting) {
      desktopWindows?.showPanel();
    }
  });
}
