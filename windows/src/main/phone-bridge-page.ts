import { PhoneBridgeStatus } from "../shared/contracts";

/**
 * The page a phone opens. It is one self-contained document — no fonts, no
 * libraries, no build step, nothing fetched from anywhere — because it has to
 * load instantly on a phone over a home wi-fi network, and because a page that
 * pulls in a CDN is a page that stops working when the internet does.
 *
 * It shows what the pc is doing and lets the user ask a question. It cannot
 * make the pc do anything: that is the whole design of the phone window, and
 * the page says so rather than leaving it to be discovered.
 */

function escapeHtml(unescapedText: string): string {
  return unescapedText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function buildPhonePage(pairingToken: string, assistantName: string): string {
  const safeName = escapeHtml(assistantName || "Ustaad");
  const safeToken = escapeHtml(pairingToken);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>${safeName}</title>
<style>
  :root { --canvas: #22262b; --ink: #e8ecf1; --muted: #9aa3ae; --faint: #6d7681; --accent: #b6e800; --accent-bright: #d8ff4d; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px 16px 40px; background: var(--canvas); color: var(--ink);
         font: 15px/1.5 "Segoe UI", system-ui, -apple-system, sans-serif; -webkit-text-size-adjust: 100%; }
  header { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
  .mark { width: 26px; height: 26px; border-radius: 50%; background: #171a1e; border: 1px solid #2e333a; position: relative; }
  .mark::after { content: ""; position: absolute; inset: 8px 8px 7px; background: var(--accent); clip-path: polygon(50% 0, 100% 100%, 50% 74%, 0 100%); }
  h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -.01em; }
  .state { margin-left: auto; color: var(--muted); font-size: 12px; }
  .card { padding: 14px; border-radius: 14px; background: var(--canvas); border: 1px solid #2b3037; margin-bottom: 12px; }
  .label { color: var(--faint); font-size: 11px; text-transform: uppercase; letter-spacing: .09em; margin: 0 0 6px; }
  .reply { white-space: pre-wrap; }
  .reply:empty::before { content: "nothing asked yet."; color: var(--faint); }
  textarea { width: 100%; min-height: 74px; resize: vertical; padding: 11px 12px; border-radius: 12px;
             border: 1px solid #2f353d; background: #1c2024; color: var(--ink); font: inherit; }
  textarea:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { margin-top: 10px; width: 100%; padding: 13px; border: 0; border-radius: 12px; font: inherit; font-weight: 650;
           background: var(--accent-bright); color: #1b1f24; }
  button:disabled { opacity: .55; }
  ul { margin: 0; padding-left: 18px; color: var(--muted); }
  li { margin: 3px 0; }
  .note { color: var(--faint); font-size: 12px; }
  .warn { color: #ffc56a; }
</style>
</head>
<body>
<header>
  <span class="mark" aria-hidden="true"></span>
  <h1>${safeName}</h1>
  <span class="state" id="state">connecting…</span>
</header>

<section class="card">
  <p class="label">what it just said</p>
  <p class="reply" id="reply"></p>
</section>

<section class="card">
  <p class="label">ask it something</p>
  <textarea id="ask" placeholder="what is on my screen?" autocapitalize="sentences"></textarea>
  <button id="send" type="button">ask</button>
  <p class="note" id="note">answered here, on this pc — reading only. it will not click, type or open anything while it is being asked from a phone.</p>
</section>

<section class="card">
  <p class="label">on the list</p>
  <ul id="todos"><li class="note">nothing open.</li></ul>
</section>

<section class="card">
  <p class="label">coming up</p>
  <ul id="scheduled"><li class="note">no reminders or routines.</li></ul>
  <p class="note warn" id="confirmations" hidden></p>
</section>

<script>
(() => {
  const token = ${JSON.stringify(safeToken)};
  const replyElement = document.getElementById("reply");
  const stateElement = document.getElementById("state");
  const askElement = document.getElementById("ask");
  const sendButton = document.getElementById("send");
  const todosElement = document.getElementById("todos");
  const scheduledElement = document.getElementById("scheduled");
  const confirmationsElement = document.getElementById("confirmations");

  const list = (element, values, emptyText) => {
    if (!values || !values.length) {
      element.innerHTML = '<li class="note">' + emptyText + "</li>";
      return;
    }
    element.replaceChildren(...values.map((value) => {
      const item = document.createElement("li");
      item.textContent = value;
      return item;
    }));
  };

  async function refresh() {
    try {
      const response = await fetch("/api/status?token=" + encodeURIComponent(token), { cache: "no-store" });
      if (!response.ok) {
        throw new Error(response.status === 401 ? "this phone is not paired any more." : "the pc did not answer.");
      }
      const status = await response.json();
      stateElement.textContent = status.isConfigured ? status.voiceState : "no brain connected";
      if (status.responseText) {
        replyElement.textContent = status.responseText;
      }
      list(todosElement, status.openTodos, "nothing open.");
      list(scheduledElement, status.nextScheduledTasks, "no reminders or routines.");
      if (status.pendingConfirmationCount > 0) {
        confirmationsElement.hidden = false;
        confirmationsElement.textContent = status.pendingConfirmationCount === 1
          ? "one thing is waiting for you at the pc."
          : status.pendingConfirmationCount + " things are waiting for you at the pc.";
      } else {
        confirmationsElement.hidden = true;
      }
    } catch (error) {
      stateElement.textContent = "offline";
      replyElement.textContent = String(error.message || error);
    }
  }

  async function ask() {
    const text = askElement.value.trim();
    if (!text || sendButton.disabled) {
      return;
    }
    sendButton.disabled = true;
    sendButton.textContent = "thinking…";
    try {
      const response = await fetch("/api/ask?token=" + encodeURIComponent(token), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const payload = await response.json().catch(() => ({}));
      replyElement.textContent = response.ok ? payload.reply : (payload.error || "the pc could not answer.");
      if (response.ok) {
        askElement.value = "";
      }
    } catch {
      replyElement.textContent = "the pc is not reachable from here.";
    } finally {
      sendButton.disabled = false;
      sendButton.textContent = "ask";
      void refresh();
    }
  }

  sendButton.addEventListener("click", ask);
  askElement.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      ask();
    }
  });

  void refresh();
  setInterval(refresh, 4000);
})();
</script>
</body>
</html>
`;
}

/** The same status the page shows, in the shape the API returns. */
export function toPhoneBridgeJson(status: PhoneBridgeStatus): PhoneBridgeStatus {
  return status;
}
