import type {
  ClickaaPublicState,
  OverlayCursorPayload,
  OverlayPointPayload,
} from "../shared/contracts";

const buddyElement = requireElement<HTMLElement>("buddy");
const responseBubble = requireElement<HTMLElement>("response-bubble");
const pointLabel = requireElement<HTMLElement>("point-label");

let latestCursor: OverlayCursorPayload = { x: 0, y: 0, visible: false };
let isPointing = false;
let pointingAnimationGeneration = 0;
let responseText = "";
let currentVoiceState: ClickaaPublicState["voiceState"] = "idle";

function requireElement<ElementType extends HTMLElement>(elementId: string): ElementType {
  const element = document.getElementById(elementId);
  if (!element) {
    throw new Error(`Missing required overlay element #${elementId}`);
  }
  return element as ElementType;
}

function placeBuddy(x: number, y: number): void {
  const safeX = Math.max(-20, Math.min(window.innerWidth - 20, x + 10));
  const safeY = Math.max(-20, Math.min(window.innerHeight - 30, y + 13));
  buddyElement.style.transform = `translate3d(${safeX}px, ${safeY}px, 0)`;
  buddyElement.classList.toggle("flip-bubble", safeX > window.innerWidth - 370);
}

function renderResponseBubble(): void {
  const shouldShowResponse = Boolean(responseText)
    && (currentVoiceState === "responding" || isPointing);
  responseBubble.textContent = shouldShowResponse ? responseText : "";
}

function sleep(durationMilliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, durationMilliseconds));
}

function animateBuddy(
  startPoint: { x: number; y: number },
  endPoint: { x: number; y: number },
  durationMilliseconds: number,
  animationGeneration: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const animationStartTime = performance.now();
    const horizontalDistance = endPoint.x - startPoint.x;
    const verticalDistance = endPoint.y - startPoint.y;
    const arcHeight = Math.min(150, 60 + Math.hypot(horizontalDistance, verticalDistance) * 0.12);
    const controlPoint = {
      x: startPoint.x + horizontalDistance * 0.5,
      y: Math.min(startPoint.y, endPoint.y) - arcHeight,
    };

    const renderAnimationFrame = (currentTime: number): void => {
      if (animationGeneration !== pointingAnimationGeneration) {
        resolve(false);
        return;
      }

      const linearProgress = Math.min(1, (currentTime - animationStartTime) / durationMilliseconds);
      const easedProgress = linearProgress < 0.5
        ? 4 * linearProgress * linearProgress * linearProgress
        : 1 - Math.pow(-2 * linearProgress + 2, 3) / 2;
      const remainingProgress = 1 - easedProgress;
      const x = remainingProgress * remainingProgress * startPoint.x
        + 2 * remainingProgress * easedProgress * controlPoint.x
        + easedProgress * easedProgress * endPoint.x;
      const y = remainingProgress * remainingProgress * startPoint.y
        + 2 * remainingProgress * easedProgress * controlPoint.y
        + easedProgress * easedProgress * endPoint.y;
      placeBuddy(x, y);

      if (linearProgress < 1) {
        requestAnimationFrame(renderAnimationFrame);
      } else {
        resolve(true);
      }
    };

    requestAnimationFrame(renderAnimationFrame);
  });
}

async function performPointingAnimation(payload: OverlayPointPayload): Promise<void> {
  pointingAnimationGeneration += 1;
  const animationGeneration = pointingAnimationGeneration;
  isPointing = true;
  pointLabel.textContent = "";
  renderResponseBubble();
  buddyElement.classList.add("visible");

  const startPoint = latestCursor.visible
    ? { x: latestCursor.x, y: latestCursor.y }
    : {
      // Main sends cursor coordinates relative to every display, even when the
      // cursor is outside this one. Clamping that off-screen point makes Clickaa
      // enter from the physically nearest monitor edge.
      x: Math.max(20, Math.min(window.innerWidth - 20, latestCursor.x)),
      y: Math.max(20, Math.min(window.innerHeight - 20, latestCursor.y)),
    };
  const targetPoint = {
    x: Math.max(8, Math.min(window.innerWidth - 8, payload.x)),
    y: Math.max(8, Math.min(window.innerHeight - 8, payload.y)),
  };

  const reachedTarget = await animateBuddy(startPoint, targetPoint, 850, animationGeneration);
  if (!reachedTarget || animationGeneration !== pointingAnimationGeneration) {
    return;
  }

  pointLabel.textContent = payload.label;
  responseText = payload.responseText;
  renderResponseBubble();
  await sleep(2_200);
  if (animationGeneration !== pointingAnimationGeneration) {
    return;
  }

  pointLabel.textContent = "";
  const returnPoint = latestCursor.visible
    ? { x: latestCursor.x, y: latestCursor.y }
    : targetPoint;
  await animateBuddy(targetPoint, returnPoint, 650, animationGeneration);
  if (animationGeneration !== pointingAnimationGeneration) {
    return;
  }

  isPointing = false;
  renderResponseBubble();
  buddyElement.classList.toggle("visible", latestCursor.visible);
  window.clickaa.sendPointingAnimationCompleted(payload.interactionId);
}

window.clickaa.onOverlayCursor((cursorPayload) => {
  latestCursor = cursorPayload;
  if (isPointing) {
    return;
  }
  buddyElement.classList.toggle("visible", cursorPayload.visible);
  if (cursorPayload.visible) {
    placeBuddy(cursorPayload.x, cursorPayload.y);
  }
});

window.clickaa.onOverlayState(({ voiceState, audioPowerLevel }) => {
  currentVoiceState = voiceState;
  buddyElement.dataset.state = voiceState;
  buddyElement.style.setProperty("--audio-level", audioPowerLevel.toFixed(3));
  renderResponseBubble();
});

window.clickaa.onOverlayResponse((updatedResponseText) => {
  responseText = updatedResponseText;
  if (!updatedResponseText) {
    pointLabel.textContent = "";
  }
  renderResponseBubble();
});

window.clickaa.onOverlayCancelPointing(() => {
  pointingAnimationGeneration += 1;
  isPointing = false;
  pointLabel.textContent = "";
  renderResponseBubble();
  buddyElement.classList.toggle("visible", latestCursor.visible);
  if (latestCursor.visible) {
    placeBuddy(latestCursor.x, latestCursor.y);
  }
});

window.clickaa.onOverlayPoint((pointPayload) => {
  void performPointingAnimation(pointPayload);
});

document.addEventListener("contextmenu", (event) => event.preventDefault());
