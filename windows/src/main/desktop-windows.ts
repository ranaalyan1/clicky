import { BrowserWindow, Menu, nativeImage, screen, Tray } from "electron";
import { join } from "node:path";
import {
  AudioPlaybackPayload,
  ClickaaPublicState,
  CompanionVoiceState,
  FallbackSpeechPayload,
  OverlayPointPayload,
} from "../shared/contracts";

interface OverlayWindowRecord {
  browserWindow: BrowserWindow;
  displayId: number;
  bounds: Electron.Rectangle;
}

export interface DesktopWindowCallbacks {
  onToggleCursor: () => void;
  onQuit: () => void;
}

export class ClickaaDesktopWindows {
  private panelWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private readonly overlayWindows = new Map<number, OverlayWindowRecord>();
  private overlayWindowsShouldBeVisible = false;
  private cursorBroadcastTimer: NodeJS.Timeout | null = null;
  private latestPublicState: ClickaaPublicState | null = null;
  private isQuitting = false;

  constructor(private readonly callbacks: DesktopWindowCallbacks) {}

  async create(): Promise<void> {
    await this.createPanelWindow();
    this.createTray();
    await this.rebuildOverlayWindows();
    this.startCursorBroadcasting();
  }

  getPanelWindow(): BrowserWindow | null {
    return this.panelWindow;
  }

  isPanelWebContents(webContentsId: number): boolean {
    return this.panelWindow?.webContents.id === webContentsId;
  }

  isOverlayWebContents(webContentsId: number): boolean {
    return [...this.overlayWindows.values()].some(
      (overlayWindowRecord) => overlayWindowRecord.browserWindow.webContents.id === webContentsId,
    );
  }

  publishState(publicState: ClickaaPublicState): void {
    const trayMenuNeedsRefresh = this.latestPublicState === null
      || this.latestPublicState.cursorEnabled !== publicState.cursorEnabled;
    this.latestPublicState = publicState;
    this.sendToPanel("clickaa:state", publicState);
    this.broadcastToOverlays("overlay:state", {
      voiceState: publicState.voiceState,
      audioPowerLevel: publicState.audioPowerLevel,
    });
    if (trayMenuNeedsRefresh) {
      this.rebuildTrayContextMenu();
    }
  }

  updateOverlayVoiceState(voiceState: CompanionVoiceState, audioPowerLevel: number): void {
    this.broadcastToOverlays("overlay:state", { voiceState, audioPowerLevel });
  }

  updateOverlayResponse(responseText: string): void {
    this.broadcastToOverlays("overlay:response", responseText);
  }

  cancelPointingAnimation(): void {
    this.broadcastToOverlays("overlay:cancel-pointing");
  }

  pointOverlayAt(
    interactionId: number,
    displayId: number,
    globalPoint: { x: number; y: number },
    label: string,
    responseText: string,
  ): boolean {
    const overlayWindowRecord = this.overlayWindows.get(displayId);
    if (!overlayWindowRecord) {
      return false;
    }

    const pointPayload: OverlayPointPayload = {
      interactionId,
      x: globalPoint.x - overlayWindowRecord.bounds.x,
      y: globalPoint.y - overlayWindowRecord.bounds.y,
      label,
      responseText,
    };
    overlayWindowRecord.browserWindow.webContents.send("overlay:point", pointPayload);
    return true;
  }

  setOverlayVisibility(shouldBeVisible: boolean): void {
    this.overlayWindowsShouldBeVisible = shouldBeVisible;
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      if (shouldBeVisible) {
        overlayWindowRecord.browserWindow.showInactive();
        overlayWindowRecord.browserWindow.setAlwaysOnTop(true, "screen-saver");
      } else {
        overlayWindowRecord.browserWindow.hide();
      }
    }
  }

  beginMicrophoneCapture(interactionId: number): void {
    this.sendToPanel("audio-capture:start", { interactionId });
  }

  endMicrophoneCapture(interactionId: number): void {
    this.sendToPanel("audio-capture:stop", { interactionId });
  }

  playAudio(payload: AudioPlaybackPayload): void {
    this.sendToPanel("audio-playback:play", payload);
  }

  speakWithWindowsVoice(payload: FallbackSpeechPayload): void {
    this.sendToPanel("audio-playback:fallback-speech", payload);
  }

  stopAudioPlayback(): void {
    this.sendToPanel("audio-playback:stop");
  }

  showPanel(): void {
    if (!this.panelWindow || this.panelWindow.isDestroyed()) {
      return;
    }

    this.positionPanelBesideTray();
    this.panelWindow.show();
    this.panelWindow.focus();
  }

  hidePanel(): void {
    this.panelWindow?.hide();
  }

  togglePanel(): void {
    if (this.panelWindow?.isVisible()) {
      this.hidePanel();
    } else {
      this.showPanel();
    }
  }

  async rebuildOverlayWindows(): Promise<void> {
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      overlayWindowRecord.browserWindow.destroy();
    }
    this.overlayWindows.clear();

    const preloadPath = join(__dirname, "../preload/preload.js");
    const overlayHtmlPath = join(__dirname, "../renderer/overlay.html");

    await Promise.all(screen.getAllDisplays().map(async (display) => {
      const overlayWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        show: false,
        focusable: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          backgroundThrottling: false,
        },
      });

      overlayWindow.setIgnoreMouseEvents(true, { forward: true });
      overlayWindow.setAlwaysOnTop(true, "screen-saver");
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      overlayWindow.setContentProtection(true);
      overlayWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      overlayWindow.webContents.on("will-navigate", (event) => event.preventDefault());

      const overlayWindowRecord: OverlayWindowRecord = {
        browserWindow: overlayWindow,
        displayId: display.id,
        bounds: { ...display.bounds },
      };
      this.overlayWindows.set(display.id, overlayWindowRecord);

      await overlayWindow.loadFile(overlayHtmlPath, {
        query: {
          displayId: String(display.id),
          displayX: String(display.bounds.x),
          displayY: String(display.bounds.y),
        },
      });

      if (this.latestPublicState) {
        overlayWindow.webContents.send("overlay:state", {
          voiceState: this.latestPublicState.voiceState,
          audioPowerLevel: this.latestPublicState.audioPowerLevel,
        });
        overlayWindow.webContents.send("overlay:response", this.latestPublicState.responseText);
      }

      if (this.overlayWindowsShouldBeVisible) {
        overlayWindow.showInactive();
      }
    }));
  }

  destroy(): void {
    this.isQuitting = true;
    if (this.cursorBroadcastTimer) {
      clearInterval(this.cursorBroadcastTimer);
      this.cursorBroadcastTimer = null;
    }
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      overlayWindowRecord.browserWindow.destroy();
    }
    this.overlayWindows.clear();
    this.panelWindow?.destroy();
    this.panelWindow = null;
    this.tray?.destroy();
    this.tray = null;
  }

  private async createPanelWindow(): Promise<void> {
    const preloadPath = join(__dirname, "../preload/preload.js");
    const panelHtmlPath = join(__dirname, "../renderer/panel.html");

    this.panelWindow = new BrowserWindow({
      width: 370,
      height: 680,
      frame: false,
      transparent: false,
      backgroundColor: "#111714",
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    this.panelWindow.setContentProtection(true);
    this.panelWindow.on("close", (event) => {
      if (!this.isQuitting) {
        event.preventDefault();
        this.panelWindow?.hide();
      }
    });
    this.panelWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.panelWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    await this.panelWindow.loadFile(panelHtmlPath);
  }

  private createTray(): void {
    const trayIconPath = join(__dirname, "../../assets/tray.png");
    const trayIcon = nativeImage.createFromPath(trayIconPath);
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip("Clickaa — hold Ctrl + Alt to talk");
    this.tray.on("click", () => this.togglePanel());
    this.rebuildTrayContextMenu();
  }

  private rebuildTrayContextMenu(): void {
    if (!this.tray) {
      return;
    }

    const cursorEnabled = this.latestPublicState?.cursorEnabled ?? true;
    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: "Open Clickaa",
        click: () => this.showPanel(),
      },
      {
        label: "Show Clickaa cursor",
        type: "checkbox",
        checked: cursorEnabled,
        click: () => this.callbacks.onToggleCursor(),
      },
      { type: "separator" },
      {
        label: "Quit Clickaa",
        click: () => this.callbacks.onQuit(),
      },
    ]));
  }

  private positionPanelBesideTray(): void {
    if (!this.panelWindow || !this.tray) {
      return;
    }

    const panelBounds = this.panelWindow.getBounds();
    const trayBounds = this.tray.getBounds();
    const trayCenter = {
      x: Math.round(trayBounds.x + trayBounds.width / 2),
      y: Math.round(trayBounds.y + trayBounds.height / 2),
    };
    const nearestDisplay = screen.getDisplayNearestPoint(trayCenter);
    const workArea = nearestDisplay.workArea;
    const gap = 8;

    let panelX = Math.round(trayBounds.x + trayBounds.width / 2 - panelBounds.width / 2);
    panelX = Math.max(workArea.x + gap, Math.min(
      panelX,
      workArea.x + workArea.width - panelBounds.width - gap,
    ));

    const taskbarIsBelowWorkArea = trayCenter.y >= workArea.y + workArea.height;
    let panelY = taskbarIsBelowWorkArea
      ? trayBounds.y - panelBounds.height - gap
      : trayBounds.y + trayBounds.height + gap;
    panelY = Math.max(workArea.y + gap, Math.min(
      panelY,
      workArea.y + workArea.height - panelBounds.height - gap,
    ));

    this.panelWindow.setPosition(panelX, panelY, false);
  }

  private startCursorBroadcasting(): void {
    if (this.cursorBroadcastTimer) {
      return;
    }

    this.cursorBroadcastTimer = setInterval(() => {
      if (!this.overlayWindowsShouldBeVisible) {
        return;
      }

      const cursorPoint = screen.getCursorScreenPoint();
      for (const overlayWindowRecord of this.overlayWindows.values()) {
        const { bounds, browserWindow } = overlayWindowRecord;
        const cursorIsOnDisplay = cursorPoint.x >= bounds.x
          && cursorPoint.x < bounds.x + bounds.width
          && cursorPoint.y >= bounds.y
          && cursorPoint.y < bounds.y + bounds.height;
        browserWindow.webContents.send("overlay:cursor", {
          x: cursorPoint.x - bounds.x,
          y: cursorPoint.y - bounds.y,
          visible: cursorIsOnDisplay,
        });
      }
    }, 16);
  }

  private sendToPanel(channel: string, ...payload: unknown[]): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.webContents.send(channel, ...payload);
    }
  }

  private broadcastToOverlays(channel: string, ...payload: unknown[]): void {
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      if (!overlayWindowRecord.browserWindow.isDestroyed()) {
        overlayWindowRecord.browserWindow.webContents.send(channel, ...payload);
      }
    }
  }
}
