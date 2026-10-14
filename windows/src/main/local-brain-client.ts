import { BrainStreamRequest } from "./brain-types";
import { ServerSentEventTextParser } from "./sse-parser";

/**
 * The brain that lives on the user's own machine.
 *
 * Ollama, LM Studio, Jan and llama.cpp all speak the same OpenAI-shaped chat
 * API on localhost, so one client covers every one of them and nothing about
 * the user's words leaves their own network. The parts worth testing — the
 * address rules, the streaming reader and the sentences when nothing answers —
 * are pure functions; only the two calls at the bottom touch the network.
 */

export const localChatPath = "/v1/chat/completions";
export const localModelsPath = "/v1/models";
export const localRequestTimeoutMilliseconds = 180_000;

/**
 * Cleans up whatever the user pasted for their local brain.
 *
 * People paste every shape of this: with a port, without a scheme, with a
 * trailing slash or a `/v1` already on the end. All of them mean the same
 * server, and any of them is refused when it points somewhere public, because
 * "local" is a promise about where the user's words go.
 */
export function normalizeLocalBrainBaseUrl(rawBaseUrl: string): string {
  const trimmedBaseUrl = rawBaseUrl.trim();
  if (!trimmedBaseUrl) {
    return "";
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(/^https?:\/\//iu.test(trimmedBaseUrl) ? trimmedBaseUrl : `http://${trimmedBaseUrl}`);
  } catch {
    throw new Error("that does not look like an address. try http://127.0.0.1:11434");
  }

  if (!isLocalBrainHost(parsedBaseUrl.hostname)) {
    throw new Error("a local brain has to be on this pc or your own network, and that address is on the internet.");
  }

  const trimmedPath = parsedBaseUrl.pathname.replace(/\/+$/u, "").replace(/\/v1$/u, "");
  return `${parsedBaseUrl.protocol}//${parsedBaseUrl.host}${trimmedPath}`;
}

/**
 * True for this machine and for a private network, false for the internet.
 *
 * The private ranges are allowed deliberately: a small model on a desktop
 * serving a laptop is still the user's own hardware, and nothing leaves the
 * house.
 */
export function isLocalBrainHost(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  if (!normalizedHost) {
    return false;
  }
  if (normalizedHost === "localhost" || normalizedHost.endsWith(".local")) {
    return true;
  }
  if (normalizedHost === "::1" || normalizedHost === "0:0:0:0:0:0:0:1") {
    return true;
  }

  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalizedHost);
  if (!ipv4Match) {
    return false;
  }
  const octets = ipv4Match.slice(1, 5).map((octet) => Number(octet));
  if (octets.some((octet) => octet > 255)) {
    return false;
  }

  const [firstOctet = 0, secondOctet = 0] = octets;
  if (firstOctet === 127 || firstOctet === 10) {
    return true;
  }
  if (firstOctet === 192 && secondOctet === 168) {
    return true;
  }
  if (firstOctet === 172 && secondOctet >= 16 && secondOctet <= 31) {
    return true;
  }
  return false;
}

export function buildLocalBrainUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/u, "")}${path}`;
}

/** Reads one streamed chunk of an OpenAI-shaped answer. */
export function readLocalTextDelta(serializedEventData: string): string {
  if (!serializedEventData || serializedEventData === "[DONE]") {
    return "";
  }

  try {
    const eventPayload = JSON.parse(serializedEventData) as {
      choices?: Array<{ delta?: { content?: unknown } }>;
    };
    const content = eventPayload.choices?.[0]?.delta?.content;
    return typeof content === "string" ? content : "";
  } catch {
    // A malformed optional event must not discard text already received.
    return "";
  }
}

/**
 * Builds the request body, dropping screenshots when the user's model cannot
 * look at them.
 *
 * Sending an image to a model that has no eyes makes the whole request fail,
 * so the honest version is to leave it out and say in the prompt that the
 * screen cannot be seen. The model then asks rather than guessing.
 */
export function buildLocalChatRequest(
  model: string,
  request: BrainStreamRequest,
  canSeeScreen: boolean,
): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [
    {
      role: "system",
      content: canSeeScreen
        ? request.systemPrompt
        : `${request.systemPrompt}\n\nyou cannot see the screen in this setup, and you have no screenshots. say you cannot look at the screen instead of guessing what is on it.`,
    },
  ];

  for (const exchange of request.conversationHistory) {
    messages.push({ role: "user", content: exchange.userTranscript });
    messages.push({ role: "assistant", content: exchange.assistantResponse });
  }

  if (canSeeScreen && request.images.length > 0) {
    const contentParts: Array<Record<string, unknown>> = request.images.map((image) => ({
      type: "image_url",
      image_url: { url: `data:${image.mediaType};base64,${image.base64Data}` },
    }));
    contentParts.push(...request.images.map((image) => ({ type: "text", text: image.label })));
    contentParts.push({ type: "text", text: request.userPrompt });
    messages.push({ role: "user", content: contentParts });
  } else {
    messages.push({ role: "user", content: request.userPrompt });
  }

  return {
    model,
    messages,
    stream: true,
    temperature: 0.7,
    max_tokens: 1_024,
  };
}

/** A local server that answers, and the models it has loaded. */
export class LocalBrainClient {
  async listModels(baseUrl: string): Promise<string[]> {
    const response = await this.callLocalBrain(
      buildLocalBrainUrl(baseUrl, localModelsPath),
      null,
      AbortSignal.timeout(12_000),
      12_000,
    );
    if (!response.ok) {
      throw new Error(await this.describeLocalFailure(response));
    }

    const modelsPayload = await response.json() as { data?: Array<{ id?: unknown }> };
    return (modelsPayload.data ?? [])
      .map((listedModel) => (typeof listedModel.id === "string" ? listedModel.id : ""))
      .filter(Boolean);
  }

  async streamChat(
    request: BrainStreamRequest,
    baseUrl: string,
    model: string,
    canSeeScreen: boolean,
  ): Promise<string> {
    const response = await this.callLocalBrain(
      buildLocalBrainUrl(baseUrl, localChatPath),
      buildLocalChatRequest(model, request, canSeeScreen),
      request.signal,
      localRequestTimeoutMilliseconds,
    );

    if (!response.ok || !response.body) {
      throw new Error(await this.describeLocalFailure(response));
    }

    const responseReader = response.body.getReader();
    const textDecoder = new TextDecoder();
    const eventParser = new ServerSentEventTextParser();
    let accumulatedText = "";

    const readSerializedEvents = (serializedEvents: string[]): void => {
      for (const serializedEvent of serializedEvents) {
        const textDelta = readLocalTextDelta(serializedEvent);
        if (!textDelta) {
          continue;
        }
        accumulatedText += textDelta;
        request.onTextUpdate?.(accumulatedText);
      }
    };

    while (true) {
      const { done, value } = await responseReader.read();
      if (done) {
        break;
      }
      readSerializedEvents(eventParser.appendChunk(textDecoder.decode(value, { stream: true })));
    }
    readSerializedEvents(eventParser.appendChunk(textDecoder.decode()));
    readSerializedEvents(eventParser.finish());

    if (!accumulatedText.trim()) {
      throw new Error(`${model} finished without writing anything. try a different model or a shorter question.`);
    }

    return accumulatedText;
  }

  /** Turns a failed call into a sentence about the user's own machine. */
  async describeLocalFailure(response: Response): Promise<string> {
    if (response.status === 404) {
      return "the server answered but has no such model loaded. check the model name in the setup tab against the list your server shows.";
    }
    if (response.status === 400) {
      const bodyText = (await response.text()).slice(0, 300);
      return `the local server refused the request: ${bodyText || "no reason given"}`;
    }

    const bodyText = (await response.text()).slice(0, 300);
    if (response.status >= 500) {
      return `the local server failed: ${bodyText || `status ${response.status}`}`;
    }
    return bodyText || `the local server answered with status ${response.status}`;
  }

  private async callLocalBrain(
    url: string,
    requestBody: Record<string, unknown> | null,
    signal: AbortSignal,
    timeoutMilliseconds: number,
  ): Promise<Response> {
    try {
      return await fetch(url, {
        method: requestBody ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: requestBody ? JSON.stringify(requestBody) : undefined,
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      throw new Error(
        `nothing answered at ${url} (${errorMessage}). start your local model server — ollama serve, or the server tab in LM Studio — and check the address in the setup tab.`,
      );
    }
  }
}