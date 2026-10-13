import WebSocket, { RawData } from "ws";

interface AssemblyBeginMessage {
  type: "Begin" | "begin";
}

interface AssemblyTurnMessage {
  type: "Turn" | "turn";
  transcript?: string;
  turn_order?: number;
  end_of_turn?: boolean;
  turn_is_formatted?: boolean;
}

interface AssemblyErrorMessage {
  type: "Error" | "error";
  error?: string;
  message?: string;
}

type AssemblyMessage = AssemblyBeginMessage | AssemblyTurnMessage | AssemblyErrorMessage | {
  type: string;
};

interface StoredTurnTranscript {
  transcriptText: string;
  isFormatted: boolean;
}

export interface AssemblyAITranscriptionSessionOptions {
  workerBaseUrl: string;
  keyterms?: string[];
  onTranscriptUpdate: (transcriptText: string) => void;
  onFinalTranscript: (transcriptText: string) => void;
  onError: (error: Error) => void;
}

export class AssemblyAITranscriptionSession {
  private webSocket: WebSocket | null = null;
  private isReady = false;
  private isCancelled = false;
  private isAwaitingFinalTranscript = false;
  private hasDeliveredFinalTranscript = false;
  private latestTranscriptText = "";
  private activeTurnOrder: number | null = null;
  private activeTurnTranscriptText = "";
  private readonly storedTurns = new Map<number, StoredTurnTranscript>();
  private finalTranscriptTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: AssemblyAITranscriptionSessionOptions) {}

  get ready(): boolean {
    return this.isReady;
  }

  async open(signal?: AbortSignal): Promise<void> {
    const tokenRequestSignal = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    const tokenResponse = await fetch(`${this.options.workerBaseUrl}/transcribe-token`, {
      method: "POST",
      signal: tokenRequestSignal,
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text();
      throw new Error(
        `Could not start transcription (${tokenResponse.status}): ${errorBody.slice(0, 500)}`,
      );
    }

    const tokenPayload = await tokenResponse.json() as { token?: unknown };
    if (typeof tokenPayload.token !== "string" || !tokenPayload.token) {
      throw new Error("The Worker returned an invalid AssemblyAI token.");
    }

    if (this.isCancelled || signal?.aborted) {
      throw new DOMException("The transcription request was cancelled.", "AbortError");
    }

    const websocketUrl = this.makeWebsocketUrl(tokenPayload.token);

    await new Promise<void>((resolve, reject) => {
      let hasSettledOpenRequest = false;
      const openTimeout = setTimeout(() => {
        settleWithError(new Error("AssemblyAI took too long to open the transcription stream."));
      }, 12_000);

      const settleWithSuccess = (): void => {
        if (hasSettledOpenRequest) {
          return;
        }
        hasSettledOpenRequest = true;
        clearTimeout(openTimeout);
        this.isReady = true;
        resolve();
      };

      const settleWithError = (error: Error): void => {
        if (hasSettledOpenRequest) {
          this.handleSessionError(error);
          return;
        }
        hasSettledOpenRequest = true;
        clearTimeout(openTimeout);
        reject(error);
      };

      const websocket = new WebSocket(websocketUrl);
      this.webSocket = websocket;

      websocket.on("message", (rawMessage) => {
        try {
          const parsedMessage = this.parseMessage(rawMessage);
          if (parsedMessage.type.toLowerCase() === "begin") {
            settleWithSuccess();
          }
          this.handleIncomingMessage(parsedMessage);
        } catch (error) {
          settleWithError(error instanceof Error ? error : new Error(String(error)));
        }
      });

      websocket.on("error", (error) => {
        settleWithError(error);
      });

      websocket.on("close", () => {
        if (!hasSettledOpenRequest && !this.isCancelled) {
          settleWithError(new Error("AssemblyAI closed the transcription stream before it was ready."));
          return;
        }

        if (this.isAwaitingFinalTranscript && !this.hasDeliveredFinalTranscript) {
          this.deliverFinalTranscript();
        }
      });

      signal?.addEventListener("abort", () => {
        this.cancel();
        settleWithError(new DOMException("The transcription request was cancelled.", "AbortError"));
      }, { once: true });
    });
  }

  appendAudio(audioData: Buffer): void {
    if (!this.isReady || this.isCancelled || !audioData.length) {
      return;
    }

    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(audioData);
    }
  }

  requestFinalTranscript(): void {
    if (this.isCancelled || this.hasDeliveredFinalTranscript) {
      return;
    }

    this.isAwaitingFinalTranscript = true;
    this.sendJsonMessage({ type: "ForceEndpoint" });
    this.clearFinalTranscriptTimer();
    this.finalTranscriptTimer = setTimeout(() => {
      this.deliverFinalTranscript();
    }, 1_600);
  }

  cancel(): void {
    if (this.isCancelled) {
      return;
    }

    this.isCancelled = true;
    this.clearFinalTranscriptTimer();
    this.sendJsonMessage({ type: "Terminate" });
    this.webSocket?.close(1000, "Clickaa session ended");
    this.webSocket = null;
  }

  private makeWebsocketUrl(temporaryToken: string): string {
    const websocketUrl = new URL("wss://streaming.assemblyai.com/v3/ws");
    websocketUrl.searchParams.set("sample_rate", "16000");
    websocketUrl.searchParams.set("encoding", "pcm_s16le");
    websocketUrl.searchParams.set("format_turns", "true");
    websocketUrl.searchParams.set("speech_model", "u3-rt-pro");
    websocketUrl.searchParams.set("token", temporaryToken);

    const normalizedKeyterms = (this.options.keyterms ?? [])
      .map((keyterm) => keyterm.trim())
      .filter(Boolean);
    if (normalizedKeyterms.length) {
      websocketUrl.searchParams.set("keyterms_prompt", JSON.stringify(normalizedKeyterms));
    }

    return websocketUrl.toString();
  }

  private parseMessage(rawMessage: RawData): AssemblyMessage {
    const serializedMessage = typeof rawMessage === "string"
      ? rawMessage
      : rawMessage.toString("utf8");
    return JSON.parse(serializedMessage) as AssemblyMessage;
  }

  private handleIncomingMessage(message: AssemblyMessage): void {
    switch (message.type.toLowerCase()) {
      case "turn":
        this.handleTurnMessage(message as AssemblyTurnMessage);
        break;
      case "termination":
        if (this.isAwaitingFinalTranscript) {
          this.deliverFinalTranscript();
        }
        break;
      case "error": {
        const errorMessage = message as AssemblyErrorMessage;
        this.handleSessionError(new Error(
          errorMessage.error || errorMessage.message || "AssemblyAI returned an error.",
        ));
        break;
      }
      default:
        break;
    }
  }

  private handleTurnMessage(turnMessage: AssemblyTurnMessage): void {
    const transcriptText = turnMessage.transcript?.trim() ?? "";
    const turnOrder = turnMessage.turn_order
      ?? this.activeTurnOrder
      ?? (Math.max(-1, ...this.storedTurns.keys()) + 1);
    const isCompletedTurn = turnMessage.end_of_turn === true
      || turnMessage.turn_is_formatted === true;

    if (isCompletedTurn) {
      this.activeTurnOrder = null;
      this.activeTurnTranscriptText = "";
      if (transcriptText) {
        const existingTurn = this.storedTurns.get(turnOrder);
        if (!existingTurn?.isFormatted || turnMessage.turn_is_formatted === true) {
          this.storedTurns.set(turnOrder, {
            transcriptText,
            isFormatted: turnMessage.turn_is_formatted === true,
          });
        }
      }
    } else {
      this.activeTurnOrder = turnOrder;
      this.activeTurnTranscriptText = transcriptText;
    }

    this.latestTranscriptText = this.composeTranscript();
    if (this.latestTranscriptText) {
      this.options.onTranscriptUpdate(this.latestTranscriptText);
    }

    if (this.isAwaitingFinalTranscript && isCompletedTurn) {
      this.deliverFinalTranscript();
    }
  }

  private composeTranscript(): string {
    const transcriptSegments = [...this.storedTurns.entries()]
      .sort(([firstTurnOrder], [secondTurnOrder]) => firstTurnOrder - secondTurnOrder)
      .map(([, storedTurn]) => storedTurn.transcriptText)
      .filter(Boolean);

    if (this.activeTurnTranscriptText.trim()) {
      transcriptSegments.push(this.activeTurnTranscriptText.trim());
    }

    return transcriptSegments.join(" ").trim();
  }

  private deliverFinalTranscript(): void {
    if (this.hasDeliveredFinalTranscript || this.isCancelled) {
      return;
    }

    this.hasDeliveredFinalTranscript = true;
    this.clearFinalTranscriptTimer();
    const finalTranscript = this.composeTranscript() || this.latestTranscriptText.trim();
    this.options.onFinalTranscript(finalTranscript);
    this.sendJsonMessage({ type: "Terminate" });
    setTimeout(() => this.webSocket?.close(1000, "Transcription complete"), 100);
  }

  private handleSessionError(error: Error): void {
    if (this.isCancelled) {
      return;
    }

    if (this.isAwaitingFinalTranscript && this.latestTranscriptText.trim()) {
      this.deliverFinalTranscript();
      return;
    }

    this.options.onError(error);
  }

  private sendJsonMessage(message: Record<string, unknown>): void {
    if (this.webSocket?.readyState === WebSocket.OPEN) {
      this.webSocket.send(JSON.stringify(message));
    }
  }

  private clearFinalTranscriptTimer(): void {
    if (this.finalTranscriptTimer) {
      clearTimeout(this.finalTranscriptTimer);
      this.finalTranscriptTimer = null;
    }
  }
}
