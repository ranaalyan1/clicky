import { BrowserWindow, Menu, nativeImage, Notification, screen, Tray } from "electron";
import { join } from "node:path";
import {
  buildSummonBand,
  IslandPresentationController,
  isPointInsideRect,
} from "./island-presentation";
import {
  AudioPlaybackPayload,
  IslandPresentation,
  UstaadPublicState,
  FallbackSpeechPayload,
  IslandState,
  OverlayCursorPayload,
  OverlayModePayload,
  OverlayPointPayload,
} from "../shared/contracts";

interface OverlayWindowRecord {
  browserWindow: BrowserWindow;
  displayId: number;
  bounds: Electron.Rectangle;
}

/** A held circle asks a question; a snip copies pixels. */
export type RegionSelectorPurpose = "circle" | "snip";

interface RegionSelectorWindowRecord {
  browserWindow: BrowserWindow;
  displayId: number;
  bounds: Electron.Rectangle;
  purpose: RegionSelectorPurpose;
}

interface IslandBounds {
  collapsedWidth: number;
  collapsedHeight: number;
  expandedWidth: number;
  expandedHeight: number;
}

const islandBounds: IslandBounds = {
  collapsedWidth: 264,
  collapsedHeight: 36,
  expandedWidth: 404,
  expandedHeight: 566,
};

const islandExpansionAnimationSteps = 8;

export interface DesktopWindowCallbacks {
  onToggleCursor: () => void;
  onToggleIsland: () => void;
  onToggleAutomationPaused: () => void;
  onToggleWakeWordMuted: () => void;
  onQuit: () => void;
}

export class UstaadDesktopWindows {
  private panelWindow: BrowserWindow | null = null;
  private islandWindow: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private readonly overlayWindows = new Map<number, OverlayWindowRecord>();
  private readonly regionSelectorWindows = new Map<number, RegionSelectorWindowRecord>();
  private overlayWindowsShouldBeVisible = false;
  private cursorBroadcastTimer: NodeJS.Timeout | null = null;
  private latestPublicState: UstaadPublicState | null = null;
  private islandAnimationFrame: NodeJS.Timeout | null = null;
  private isQuitting = false;

  private readonly islandPresentation = new IslandPresentationController();
  private islandIsEnabled = true;
  private islandSummonIsEnabled = true;
  private islandIsAlwaysVisible = false;
  private islandDisplayId: number | null = null;
  private cursorTickCount = 0;

  constructor(private readonly callbacks: DesktopWindowCallbacks) {}

  async create(): Promise<void> {
    await this.createPanelWindow();
    this.createTray();
    await this.rebuildOverlayWindows();
    this.createIslandWindow();
    this.startCursorBroadcasting();
  }

  getPanelWindow(): BrowserWindow | null {
    return this.panelWindow;
  }

  isPanelWebContents(webContentsId: number): boolean {
    return this.panelWindow?.webContents.id === webContentsId;
  }

  isIslandWebContents(webContentsId: number): boolean {
    return this.islandWindow?.webContents.id === webContentsId;
  }

  isOverlayWebContents(webContentsId: number): boolean {
    return [...this.overlayWindows.values()].some(
      (overlayWindowRecord) => overlayWindowRecord.browserWindow.webContents.id === webContentsId,
    );
  }

  isRegionSelectorWebContents(webContentsId: number): boolean {
    return [...this.regionSelectorWindows.values()].some(
      (regionSelectorWindowRecord) => regionSelectorWindowRecord.browserWindow.webContents.id === webContentsId,
    );
  }

  /** Which display a selection window belongs to, and where that display sits. */
  getRegionSelectorRecord(
    webContentsId: number,
  ): { displayId: number; bounds: Electron.Rectangle; purpose: RegionSelectorPurpose } | null {
    for (const regionSelectorWindowRecord of this.regionSelectorWindows.values()) {
      if (regionSelectorWindowRecord.browserWindow.webContents.id === webContentsId) {
        return {
          displayId: regionSelectorWindowRecord.displayId,
          bounds: { ...regionSelectorWindowRecord.bounds },
          purpose: regionSelectorWindowRecord.purpose,
        };
      }
    }
    return null;
  }

  publishState(publicState: UstaadPublicState): void {
    const trayMenuNeedsRefresh = this.latestPublicState === null
      || this.latestPublicState.cursorEnabled !== publicState.cursorEnabled
      || this.latestPublicState.islandEnabled !== publicState.islandEnabled
      || this.latestPublicState.automationPaused !== publicState.automationPaused
      || this.latestPublicState.wakeWordMuted !== publicState.wakeWordMuted
      || this.latestPublicState.wakeWordState !== publicState.wakeWordState;

    this.latestPublicState = publicState;
    this.sendToPanel("ustaad:state", publicState);
    this.broadcastToOverlays("overlay:state", {
      voiceState: publicState.voiceState,
      audioPowerLevel: publicState.audioPowerLevel,
    });

    if (trayMenuNeedsRefresh) {
      this.rebuildTrayContextMenu();
    }
  }

  publishIslandState(islandState: IslandState): void {
    this.sendToIsland("island:state", islandState);
  }

  updateOverlayResponse(responseText: string): void {
    this.broadcastToOverlays("overlay:response", responseText);
  }

  updateOverlayMode(overlayMode: OverlayModePayload): void {
    this.broadcastToOverlays("overlay:mode", overlayMode);
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

  showNotification(title: string, body: string): void {
    if (!Notification.isSupported()) {
      return;
    }
    new Notification({ title, body: body.slice(0, 400), silent: false }).show();
  }

  showPanel(page?: string): void {
    if (!this.panelWindow || this.panelWindow.isDestroyed()) {
      return;
    }

    this.positionPanelBesideTray();
    this.panelWindow.show();
    this.panelWindow.focus();
    if (page) {
      this.panelWindow.webContents.send("panel:open-page", page);
    }
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

  /** Shows the island at the top of the primary display's work area. */
  /** The master switch: with the island off, nothing ever appears. */
  setIslandEnabled(isEnabled: boolean): void {
    this.islandIsEnabled = isEnabled;
    this.refreshIslandPresentation();
  }

  setIslandSummonEnabled(isSummonEnabled: boolean): void {
    this.islandSummonIsEnabled = isSummonEnabled;
  }

  setIslandAlwaysVisible(isAlwaysVisible: boolean): void {
    this.islandIsAlwaysVisible = isAlwaysVisible;
    this.refreshIslandPresentation();
  }

  /** What the island is doing right now, for the panel and the agent loop. */
  getIslandPresentation(): IslandPresentation {
    if (!this.islandIsEnabled) {
      return "hidden";
    }
    return this.islandPresentation.presentation;
  }

  /** Opens the full island, for example when a confirmation needs an answer. */
  openIsland(): void {
    this.islandPresentation.openIsland(Date.now());
    this.refreshIslandPresentation();
  }

  /** Brings the mark out without opening it, for example when listening starts. */
  revealIsland(): void {
    this.islandPresentation.notePointerOverIsland(false, Date.now());
    this.refreshIslandPresentation();
  }

  /** Escape, or the island's own close button. */
  closeIsland(): void {
    this.islandPresentation.dismissIsland();
    this.refreshIslandPresentation();
  }

  setIslandExpanded(shouldBeExpanded: boolean): void {
    if (shouldBeExpanded) {
      this.openIsland();
      return;
    }
    this.islandPresentation.collapseIsland(Date.now());
    this.refreshIslandPresentation();
  }

  /**
   * The island must never block clicks on the desktop, so it stays click-through
   * until the pointer is actually over it. Renderers still receive mouse-move
   * events while the window ignores them, which is how the island knows.
   */
  setIslandInteractionEnabled(isInteractionEnabled: boolean): void {
    this.islandWindow?.setIgnoreMouseEvents(!isInteractionEnabled, { forward: true });
  }

  showRegionSelector(hintText: string, purpose: RegionSelectorPurpose = "circle"): void {
    this.hideRegionSelector();
    const preloadPath = join(__dirname, "../preload/preload.js");
    const selectionHtmlPath = join(__dirname, "../renderer/selection.html");

    for (const display of screen.getAllDisplays()) {
      const regionSelectorWindow = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        backgroundColor: "#00000000",
        hasShadow: false,
        show: false,
        // Clicks land in the selector, but the user's own window keeps focus.
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

      regionSelectorWindow.setAlwaysOnTop(true, "screen-saver");
      regionSelectorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      regionSelectorWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      regionSelectorWindow.webContents.on("will-navigate", (event) => event.preventDefault());

      this.regionSelectorWindows.set(display.id, {
        browserWindow: regionSelectorWindow,
        displayId: display.id,
        bounds: { ...display.bounds },
        purpose,
      });
    }

    void Promise.all([...this.regionSelectorWindows.values()].map(async (regionSelectorWindowRecord) => {
      try {
        await regionSelectorWindowRecord.browserWindow.loadFile(selectionHtmlPath, {
          query: {
            hint: hintText,
            purpose,
            displayWidth: String(regionSelectorWindowRecord.bounds.width),
            displayHeight: String(regionSelectorWindowRecord.bounds.height),
          },
        });
        regionSelectorWindowRecord.browserWindow.showInactive();
      } catch (error) {
        console.warn("Hitodama Open could not open the region selector:", error);
        regionSelectorWindowRecord.browserWindow.destroy();
        this.regionSelectorWindows.delete(regionSelectorWindowRecord.displayId);
      }
    })).catch((error: unknown) => {
      console.warn("Hitodama Open could not prepare the region selector:", error);
    });
  }

  hideRegionSelector(): void {
    for (const regionSelectorWindowRecord of this.regionSelectorWindows.values()) {
      regionSelectorWindowRecord.browserWindow.destroy();
    }
    this.regionSelectorWindows.clear();
  }

  async rebuildOverlayWindows(): Promise<void> {
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      overlayWindowRecord.browserWindow.destroy();
    }
    this.overlayWindows.clear();

    const preloadPath = join(__dirname, "../preload/preload.js");
    const overlayHtmlPath = join(__dirname, "../renderer/overlay.html");

    for (const display of screen.getAllDisplays()) {
      let overlayWindow: BrowserWindow | null = null;
      try {
        overlayWindow = new BrowserWindow({
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
      } catch (error) {
        console.warn(`Hitodama Open could not create the cursor overlay for display ${display.id}:`, error);
        if (overlayWindow && !overlayWindow.isDestroyed()) {
          overlayWindow.destroy();
        }
        this.overlayWindows.delete(display.id);
      }
    }
  }

  destroy(): void {
    this.isQuitting = true;
    if (this.cursorBroadcastTimer) {
      clearInterval(this.cursorBroadcastTimer);
      this.cursorBroadcastTimer = null;
    }
    if (this.islandAnimationFrame) {
      clearInterval(this.islandAnimationFrame);
      this.islandAnimationFrame = null;
    }
    for (const overlayWindowRecord of this.overlayWindows.values()) {
      overlayWindowRecord.browserWindow.destroy();
    }
    this.overlayWindows.clear();
    this.hideRegionSelector();
    this.islandWindow?.destroy();
    this.islandWindow = null;
    this.panelWindow?.destroy();
    this.panelWindow = null;
    this.tray?.destroy();
    this.tray = null;
  }

  private async createPanelWindow(): Promise<void> {
    const preloadPath = join(__dirname, "../preload/preload.js");
    const panelHtmlPath = join(__dirname, "../renderer/panel.html");

    this.panelWindow = new BrowserWindow({
      width: 392,
      height: 720,
      frame: false,
      transparent: false,
      backgroundColor: "#0c110f",
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

  private createIslandWindow(): void {
    const preloadPath = join(__dirname, "../preload/preload.js");
    const islandHtmlPath = join(__dirname, "../renderer/island.html");
    const collapsedBounds = this.calculateIslandBounds(false);

    this.islandWindow = new BrowserWindow({
      ...collapsedBounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // Not focusable, so clicking the island never steals the caret from the
      // window the user is dictating into.
      focusable: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });

    this.islandWindow.setAlwaysOnTop(true, "screen-saver");
    this.islandWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.islandWindow.setIgnoreMouseEvents(true, { forward: true });
    this.islandWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    this.islandWindow.webContents.on("will-navigate", (event) => event.preventDefault());
    void this.islandWindow.loadFile(islandHtmlPath).catch((error: unknown) => {
      // The island is optional chrome. A renderer/static-asset problem must not
      // prevent the panel and text assistant from starting.
      console.warn("Hitodama Open could not load its island:", error);
      this.islandWindow?.hide();
    });
  }

  private calculateIslandBounds(shouldBeExpanded: boolean, displayId?: number): Electron.Rectangle {
    const display = (displayId === undefined ? null : screen.getAllDisplays().find(
      (candidateDisplay) => candidateDisplay.id === displayId,
    )) ?? screen.getPrimaryDisplay();
    const workArea = display.workArea;
    const requestedWidth = shouldBeExpanded ? islandBounds.expandedWidth : islandBounds.collapsedWidth;
    const requestedHeight = shouldBeExpanded ? islandBounds.expandedHeight : islandBounds.collapsedHeight;

    const width = Math.min(requestedWidth, workArea.width - 16);
    const height = Math.min(requestedHeight, workArea.height - 16);

    return {
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + 6),
      width,
      height,
    };
  }

  /**
   * The single place that turns a presentation state into a real window: move it
   * onto the display the pointer is on, size it, show or hide it, and tell the
   * renderer which of the two shapes it should draw.
   */
  private applyIslandPresentation(presentation: IslandPresentation, shouldAnimate: boolean): void {
    if (!this.islandWindow || this.islandWindow.isDestroyed()) {
      return;
    }

    if (presentation === "hidden") {
      this.islandWindow.hide();
      this.sendToIsland("island:presentation", { presentation });
      return;
    }

    const cursorPoint = screen.getCursorScreenPoint();
    const pointerDisplay = screen.getDisplayNearestPoint(cursorPoint);
    if (this.islandDisplayId !== pointerDisplay.id) {
      // The mark always belongs to the display the pointer is on; when the
      // pointer is elsewhere (for example after a wake word) keep the last one.
      this.islandDisplayId = pointerDisplay.id;
    }

    const shouldBeExpanded = presentation === "open";
    const targetBounds = this.calculateIslandBounds(shouldBeExpanded, this.islandDisplayId);
    const currentBounds = this.islandWindow.getBounds();
    const isAlreadyInPlace = currentBounds.x === targetBounds.x
      && currentBounds.y === targetBounds.y
      && currentBounds.width === targetBounds.width
      && currentBounds.height === targetBounds.height;

    if (!isAlreadyInPlace) {
      if (shouldAnimate && currentBounds.width === islandBounds.collapsedWidth) {
        this.applyIslandBounds(shouldBeExpanded, true);
      } else {
        this.islandWindow.setBounds(targetBounds, false);
      }
    }

    this.islandWindow.showInactive();
    this.islandWindow.setAlwaysOnTop(true, "screen-saver");
    this.sendToIsland("island:presentation", { presentation });
  }

  /** Re-applies whatever the state machine currently says. */
  private refreshIslandPresentation(shouldAnimate = true): void {
    const presentation = this.getIslandPresentation();
    if (presentation === "hidden") {
      this.applyIslandPresentation("hidden", false);
      return;
    }
    this.applyIslandPresentation(presentation, shouldAnimate);
  }

  /**
   * Every cursor tick feeds the summon machine: the top edge of the display
   * under the pointer reveals the mark, and the pointer leaving closes it again.
   */
  private updateIslandSummoning(): void {
    const cursorPoint = screen.getCursorScreenPoint();
    const pointerDisplay = screen.getDisplayNearestPoint(cursorPoint);
    const islandBoundsOnScreen = this.islandWindow && this.islandWindow.isVisible()
      ? this.islandWindow.getBounds()
      : null;
    const pointerIsOverIsland = this.islandPresentation.presentation !== "hidden"
      && isPointInsideRect(cursorPoint, islandBoundsOnScreen);

    this.islandPresentation.notePointerOverIsland(pointerIsOverIsland, Date.now());

    const previousPresentation = this.islandPresentation.presentation;
    const nextPresentation = this.islandPresentation.update({
      nowMilliseconds: Date.now(),
      pointer: cursorPoint,
      summonBand: this.islandSummonIsEnabled && this.islandIsEnabled
        ? buildSummonBand(pointerDisplay.workArea)
        : null,
      islandBounds: islandBoundsOnScreen,
      hasActiveInteraction: this.latestPublicState?.voiceState !== undefined
        && this.latestPublicState.voiceState !== "idle",
      isAlwaysVisible: this.islandIsAlwaysVisible,
    });

    if (nextPresentation !== previousPresentation) {
      this.applyIslandPresentation(nextPresentation, true);
    }
  }

  /**
   * Resizes the island in small steps so the notch grows instead of jumping.
   * CSS cannot animate across a native window resize, so this is done here.
   */
  private applyIslandBounds(shouldBeExpanded: boolean, shouldAnimate: boolean): void {
    if (!this.islandWindow) {
      return;
    }

    const targetBounds = this.calculateIslandBounds(shouldBeExpanded);
    if (!shouldAnimate) {
      this.islandWindow.setBounds(targetBounds, false);
      return;
    }

    if (this.islandAnimationFrame) {
      clearInterval(this.islandAnimationFrame);
      this.islandAnimationFrame = null;
    }

    const startBounds = this.islandWindow.getBounds();
    let currentStep = 0;
    this.islandAnimationFrame = setInterval(() => {
      currentStep += 1;
      const progress = Math.min(1, currentStep / islandExpansionAnimationSteps);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      const interpolatedBounds = {
        x: Math.round(startBounds.x + (targetBounds.x - startBounds.x) * easedProgress),
        y: Math.round(startBounds.y + (targetBounds.y - startBounds.y) * easedProgress),
        width: Math.round(startBounds.width + (targetBounds.width - startBounds.width) * easedProgress),
        height: Math.round(startBounds.height + (targetBounds.height - startBounds.height) * easedProgress),
      };

      this.islandWindow?.setBounds(interpolatedBounds, false);
      if (progress >= 1 && this.islandAnimationFrame) {
        clearInterval(this.islandAnimationFrame);
        this.islandAnimationFrame = null;
      }
    }, 12);
  }

  private createTray(): void {
    const trayIconPath = join(__dirname, "../../assets/tray.png");
    const trayIcon = nativeImage.createFromPath(trayIconPath);
    this.tray = new Tray(trayIcon);
    this.tray.setToolTip("Hitodama Open — hold Ctrl + Alt to talk, Ctrl + Windows to dictate");
    this.tray.on("click", () => this.togglePanel());
    this.rebuildTrayContextMenu();
  }

  private rebuildTrayContextMenu(): void {
    if (!this.tray) {
      return;
    }

    const cursorEnabled = this.latestPublicState?.cursorEnabled ?? true;
    const islandEnabled = this.latestPublicState?.islandEnabled ?? true;
    const automationPaused = this.latestPublicState?.automationPaused ?? false;
    const wakeWordListening = this.latestPublicState?.wakeWordState === "listening";
    const wakeWordMuted = this.latestPublicState?.wakeWordMuted ?? false;

    this.tray.setContextMenu(Menu.buildFromTemplate([
      {
        label: "Open Hitodama Open",
        click: () => this.showPanel(),
      },
      { type: "separator" },
      {
        label: "Show the cursor buddy",
        type: "checkbox",
        checked: cursorEnabled,
        click: () => this.callbacks.onToggleCursor(),
      },
      {
        label: "Show the island",
        type: "checkbox",
        checked: islandEnabled,
        click: () => this.callbacks.onToggleIsland(),
      },
      {
        label: "Pause actions on this pc",
        type: "checkbox",
        checked: automationPaused,
        click: () => this.callbacks.onToggleAutomationPaused(),
      },
      { type: "separator" },
      {
        label: wakeWordListening ? "Wake word is listening - mute it" : "Mute the wake word",
        type: "checkbox",
        checked: wakeWordMuted,
        click: () => this.callbacks.onToggleWakeWordMuted(),
      },
      { type: "separator" },
      {
        label: "Quit Hitodama Open",
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
      this.cursorTickCount += 1;

      // Summoning is checked four times less often than the cursor is drawn:
      // 80 ms is still instant to a human eye and keeps an idle desktop cheap.
      if (this.islandIsEnabled && this.cursorTickCount % 5 === 0) {
        this.updateIslandSummoning();
      }

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
        const cursorPayload: OverlayCursorPayload = {
          x: cursorPoint.x - bounds.x,
          y: cursorPoint.y - bounds.y,
          visible: cursorIsOnDisplay,
        };
        browserWindow.webContents.send("overlay:cursor", cursorPayload);
      }
    }, 16);
  }

  private sendToPanel(channel: string, ...payload: unknown[]): void {
    if (this.panelWindow && !this.panelWindow.isDestroyed()) {
      this.panelWindow.webContents.send(channel, ...payload);
    }
  }

  private sendToIsland(channel: string, ...payload: unknown[]): void {
    if (this.islandWindow && !this.islandWindow.isDestroyed()) {
      this.islandWindow.webContents.send(channel, ...payload);
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
