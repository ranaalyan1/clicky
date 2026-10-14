import { timingSafeEqual } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { PhoneBridgeStatus } from "../shared/contracts";
import { buildPhonePage } from "./phone-bridge-page";

/**
 * The phone window's server.
 *
 * Three rules shape it, and all three are security rules rather than features:
 *
 *  1. A request is answered only with the pairing token, compared in constant
 *     time. Without it the only thing a stranger on the wi-fi gets is a refusal.
 *  2. The server binds to the local network and nothing else — no proxy, no
 *     tunnel, no cloud — so "on your phone" means "on your wi-fi".
 *  3. It can ask, and read status. It cannot act. The phone page renders a
 *     reply; it can never reach the action path, the confirmation queue, or the
 *     system-access tiers, so a stolen phone is not a remote control.
 *
 * It is deliberately built on `node:http` with no dependencies: this has to run
 * on low-spec machines, and a bridge that ships a framework to serve one page
 * is a bridge that costs more than it gives.
 */

const maximumRequestBodyBytes = 4_096;
const maximumAskLength = 500;
const requestBudgetPerMinute = 60;
const bundledPortAttempts = 10;

export interface PhoneBridgeHandlers {
  getStatus(): PhoneBridgeStatus;
  /** Answers a question. It may read the screen; it must not act on the pc. */
  ask(requestText: string): Promise<string>;
}

export interface PhoneBridgeServerOptions {
  port: number;
  token: string;
  handlers: PhoneBridgeHandlers;
  /** The interface to bind to. Tests pass 127.0.0.1; the app uses the network. */
  host?: string;
  onError?: (errorMessage: string) => void;
}

function tokenMatches(providedToken: string | null, expectedToken: string): boolean {
  if (!providedToken) {
    return false;
  }
  const providedBytes = Buffer.from(providedToken);
  const expectedBytes = Buffer.from(expectedToken);
  if (providedBytes.length !== expectedBytes.length) {
    return false;
  }
  return timingSafeEqual(providedBytes, expectedBytes);
}

function readToken(request: IncomingMessage, requestUrl: URL): string | null {
  const authorizationHeader = request.headers.authorization;
  if (authorizationHeader?.startsWith("Bearer ")) {
    return authorizationHeader.slice("Bearer ".length);
  }
  return requestUrl.searchParams.get("token");
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function sendText(response: ServerResponse, statusCode: number, body: string): void {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

/**
 * Reads a small JSON body, refusing anything larger than the budget.
 *
 * An oversized body is still answered rather than dropped: the connection is
 * left open, the rest of the body is discarded as it arrives, and the refusal
 * goes out once the client has finished talking. Killing the socket instead
 * would show the phone an error it cannot explain, and a client that refuses to
 * stop is only cut off after ten times the budget.
 */
function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let receivedBytes = 0;
    let isTooLarge = false;

    request.on("data", (chunk: Buffer) => {
      receivedBytes += chunk.length;
      if (receivedBytes > maximumRequestBodyBytes) {
        isTooLarge = true;
        chunks.length = 0;
        if (receivedBytes > maximumRequestBodyBytes * 10) {
          request.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (isTooLarge) {
        reject(new Error("too large"));
        return;
      }
      const rawBody = Buffer.concat(chunks).toString("utf8").trim();
      if (!rawBody) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(rawBody) as unknown);
      } catch {
        reject(new Error("not json"));
      }
    });
    request.on("close", () => {
      if (isTooLarge && !request.readableEnded) {
        reject(new Error("too large"));
      }
    });
    request.on("error", reject);
  });
}

export class PhoneBridgeServer {
  private readonly handlers: PhoneBridgeHandlers;
  private readonly host: string;
  private readonly onError: (errorMessage: string) => void;
  private server: Server | null = null;
  private readonly requestTimesByAddress = new Map<string, number[]>();

  constructor(
    private readonly options: PhoneBridgeServerOptions,
  ) {
    this.handlers = options.handlers;
    this.host = options.host ?? "0.0.0.0";
    this.onError = options.onError ?? (() => undefined);
  }

  get port(): number {
    const address = this.server?.address();
    return address && typeof address === "object" ? address.port : this.options.port;
  }

  get isRunning(): boolean {
    return this.server !== null;
  }

  /**
   * Binds the window, walking forward a few ports if something else already has
   * the one we used last time, and finally letting the system pick.
   */
  async start(): Promise<number> {
    if (this.server) {
      return this.port;
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= bundledPortAttempts; attempt += 1) {
      const candidatePort = this.options.port === 0 ? 0 : this.options.port + attempt;
      try {
        const boundPort = await this.listenOn(candidatePort);
        this.options.port = boundPort;
        return boundPort;
      } catch (error) {
        lastError = error;
        const errorCode = (error as NodeJS.ErrnoException).code;
        if (errorCode !== "EADDRINUSE") {
          break;
        }
      }
    }

    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    this.onError(`the phone window could not start: ${reason}`);
    throw lastError instanceof Error ? lastError : new Error(reason);
  }

  private listenOn(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void this.handleRequest(request, response).catch((error: unknown) => {
          this.onError(error instanceof Error ? error.message : String(error));
          if (!response.headersSent) {
            sendJson(response, 500, { error: "the pc hit an error answering that." });
          }
        });
      });

      server.on("error", (error) => {
        server.removeAllListeners();
        reject(error);
      });

      server.listen(port, this.host, () => {
        server.removeAllListeners("error");
        server.on("error", (error) => this.onError(error.message));
        this.server = server;
        const address = server.address();
        resolve(address && typeof address === "object" ? address.port : port);
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) {
      return;
    }
    this.server = null;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private isOverBudget(remoteAddress: string): boolean {
    const now = Date.now();
    const recentTimes = (this.requestTimesByAddress.get(remoteAddress) ?? [])
      .filter((requestTime) => now - requestTime < 60_000);
    if (recentTimes.length >= requestBudgetPerMinute) {
      this.requestTimesByAddress.set(remoteAddress, recentTimes);
      return true;
    }
    recentTimes.push(now);
    this.requestTimesByAddress.set(remoteAddress, recentTimes);
    return false;
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    const requestUrl = new URL(request.url ?? "/", `http://${this.host}`);

    if (this.isOverBudget(remoteAddress)) {
      sendJson(response, 429, { error: "too many requests from this device." });
      return;
    }

    if (!tokenMatches(readToken(request, requestUrl), this.options.token)) {
      sendText(
        response,
        401,
        "This page only opens with the link shown on the pc. Open Ustaad on the pc and copy the address again.",
      );
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/") {
      const page = buildPhonePage(this.options.token, this.handlers.getStatus().assistantName);
      response.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Length": Buffer.byteLength(page),
        "Cache-Control": "no-store",
        // The page is one document with its own styles and script, and it must
        // not be able to reach anywhere else. This is the strictest policy that
        // still lets it work.
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(page);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/status") {
      sendJson(response, 200, this.handlers.getStatus());
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/ask") {
      let parsedBody: unknown;
      try {
        parsedBody = await readJsonBody(request);
      } catch (error) {
        const reason = error instanceof Error ? error.message : "bad request";
        sendJson(response, reason === "too large" ? 413 : 400, { error: "that request was not readable." });
        return;
      }

      const possibleText = (parsedBody as { text?: unknown } | null)?.text;
      if (typeof possibleText !== "string" || !possibleText.trim()) {
        sendJson(response, 400, { error: "ask it something first." });
        return;
      }
      if (possibleText.length > maximumAskLength) {
        sendJson(response, 413, { error: `keep it under ${maximumAskLength} characters.` });
        return;
      }

      try {
        const reply = await this.handlers.ask(possibleText.trim());
        sendJson(response, 200, { reply });
      } catch (error) {
        sendJson(response, 502, {
          error: error instanceof Error ? error.message : "the pc could not answer that.",
        });
      }
      return;
    }

    sendJson(response, 404, { error: "no such thing here." });
  }
}
