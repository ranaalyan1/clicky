export interface AnthropicTextDelta {
  type?: string;
  delta?: {
    type?: string;
    text?: string;
  };
}

/** Incrementally separates SSE data fields even when network chunks split a line. */
export class ServerSentEventTextParser {
  private unfinishedLine = "";

  appendChunk(responseChunk: string): string[] {
    this.unfinishedLine += responseChunk;
    const completeLines = this.unfinishedLine.split(/\r?\n/);
    this.unfinishedLine = completeLines.pop() ?? "";
    return this.extractDataFields(completeLines);
  }

  finish(): string[] {
    const remainingLine = this.unfinishedLine;
    this.unfinishedLine = "";
    return this.extractDataFields(remainingLine ? [remainingLine] : []);
  }

  private extractDataFields(lines: string[]): string[] {
    return lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
  }
}

export function extractTextDelta(serializedEventData: string): string {
  if (!serializedEventData || serializedEventData === "[DONE]") {
    return "";
  }

  try {
    const eventPayload = JSON.parse(serializedEventData) as AnthropicTextDelta;
    if (
      eventPayload.type === "content_block_delta"
      && eventPayload.delta?.type === "text_delta"
      && typeof eventPayload.delta.text === "string"
    ) {
      return eventPayload.delta.text;
    }
  } catch {
    // Unknown SSE events are ignored; a malformed optional event should not
    // discard the valid response text already received.
  }

  return "";
}
