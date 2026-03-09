/**
 * YUAN CLI — Cloud Client
 *
 * API client for YUAN CLI cloud mode.
 * Connects to yua-backend (:4000) via REST + SSE.
 *
 * - Auth via x-api-key header (yua_sk_xxx)
 * - SSE streaming with automatic reconnection
 * - No external dependencies (native fetch)
 */

// ─── Event Types ───

export interface TextDeltaEvent {
  kind: "text_delta";
  text: string;
}

export interface ToolCallEvent {
  kind: "tool_call";
  tool: string;
  input: unknown;
}

export interface ToolResultEvent {
  kind: "tool_result";
  output: string;
}

export interface ThinkingEvent {
  kind: "thinking";
  content: string;
}

export interface ApprovalNeededEvent {
  kind: "approval_needed";
  actionId: string;
  tool: string;
  description: string;
  risk: string;
}

export interface ErrorEvent {
  kind: "error";
  message: string;
}

export interface DoneEvent {
  kind: "done";
  status: string;
}

export interface StatusChangeEvent {
  kind: "status_change";
  status: string;
}

export type AgentEvent =
  | TextDeltaEvent
  | ToolCallEvent
  | ToolResultEvent
  | ThinkingEvent
  | ApprovalNeededEvent
  | ErrorEvent
  | DoneEvent
  | StatusChangeEvent;

// ─── SSE Event-Type → Kind Mapping ───

const SSE_EVENT_MAP: Record<string, AgentEvent["kind"]> = {
  "agent:text_delta": "text_delta",
  "agent:tool_call": "tool_call",
  "agent:tool_result": "tool_result",
  "agent:thinking": "thinking",
  "agent:approval_needed": "approval_needed",
  "agent:error": "error",
  "agent:done": "done",
  "agent:status_change": "status_change",
};

// ─── Request/Response Types ───

export interface StartSessionOptions {
  model?: string;
  workDir?: string;
  maxIterations?: number;
  autoApprove?: boolean;
}

export interface StartSessionResponse {
  sessionId: string;
  status: string;
}

export interface ApprovalResponse {
  approved: boolean;
  message?: string;
}

export interface SessionInfo {
  id: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  iteration: number;
  tokenUsage: { input: number; output: number };
}

export interface SessionStatus {
  sessionId: string;
  status: string;
  iteration: number;
  tokenUsage: { input: number; output: number };
}

export interface LlmChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  system?: string;
}

export interface LlmChatMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LlmChatResponse {
  content: string;
  model: string;
  usage: { input: number; output: number };
}

export interface StreamOptions {
  /** AbortSignal for cancellation */
  signal?: AbortSignal;
  /** Max reconnection attempts (default: 5) */
  maxReconnects?: number;
  /** Base delay between reconnections in ms (default: 1000) */
  reconnectDelay?: number;
}

// ─── Error ───

export class CloudClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "CloudClientError";
  }
}

// ─── SSE Parser ───

/**
 * Parses an SSE byte stream into structured events.
 * Handles event:, data:, id: fields, multi-line data, and keep-alive comments.
 */
class SSEParser {
  private buffer = "";
  private eventType = "";
  private dataLines: string[] = [];
  private lastEventId = "";

  /** Returns the last received event ID (for reconnection via Last-Event-Id). */
  getLastEventId(): string {
    return this.lastEventId;
  }

  /**
   * Feed raw text into the parser.
   * Returns an array of parsed events (may be empty if data is incomplete).
   */
  feed(chunk: string): Array<{ event: string; data: string; id: string }> {
    this.buffer += chunk;
    const events: Array<{ event: string; data: string; id: string }> = [];

    // Process complete lines (SSE uses \n, \r\n, or \r as line endings)
    const lines = this.buffer.split(/\r\n|\r|\n/);

    // Last element is incomplete — keep it in the buffer
    this.buffer = lines.pop() ?? "";

    for (const line of lines) {
      // Keep-alive comment
      if (line.startsWith(":")) {
        continue;
      }

      // Empty line = dispatch event
      if (line === "") {
        if (this.dataLines.length > 0) {
          const data = this.dataLines.join("\n");
          events.push({
            event: this.eventType || "message",
            data,
            id: this.lastEventId,
          });
        }
        // Reset for next event
        this.eventType = "";
        this.dataLines = [];
        continue;
      }

      // Parse field
      const colonIdx = line.indexOf(":");
      let field: string;
      let value: string;

      if (colonIdx === -1) {
        // Line with no colon — field name is the entire line, value is empty
        field = line;
        value = "";
      } else {
        field = line.slice(0, colonIdx);
        // Skip optional single leading space after colon
        value = line[colonIdx + 1] === " "
          ? line.slice(colonIdx + 2)
          : line.slice(colonIdx + 1);
      }

      switch (field) {
        case "event":
          this.eventType = value;
          break;
        case "data":
          this.dataLines.push(value);
          break;
        case "id":
          // Per spec, ignore ids containing null
          if (!value.includes("\0")) {
            this.lastEventId = value;
          }
          break;
        case "retry":
          // Retry field — ignored (we handle reconnection externally)
          break;
        default:
          // Unknown field — ignore per spec
          break;
      }
    }

    return events;
  }

  /** Reset parser state (for reconnection). */
  reset(): void {
    this.buffer = "";
    this.eventType = "";
    this.dataLines = [];
    // lastEventId is intentionally preserved across resets for reconnection
  }
}

// ─── Cloud Client ───

/**
 * CloudClient — API client for YUAN CLI cloud mode.
 *
 * Connects to yua-backend via REST + SSE streaming.
 * Auth via x-api-key header using a stored API key (yua_sk_xxx).
 */
export class CloudClient {
  constructor(
    private serverUrl: string,
    private apiKey: string,
  ) {
    // Strip trailing slash
    if (this.serverUrl.endsWith("/")) {
      this.serverUrl = this.serverUrl.slice(0, -1);
    }
  }

  // ─── Public Methods ───

  /**
   * Start a new agent session.
   *
   * @param prompt - The user's prompt / task description
   * @param options - Session options (model, workDir, etc.)
   */
  async startSession(
    prompt: string,
    options: StartSessionOptions = {},
  ): Promise<StartSessionResponse> {
    return this.post<StartSessionResponse>("/api/yuan-agent/run", {
      prompt,
      ...options,
    });
  }

  /**
   * Stream agent events via SSE.
   *
   * Connects to the SSE endpoint and invokes `onEvent` for each parsed event.
   * Automatically reconnects using Last-Event-Id on transient failures.
   *
   * @param sessionId - The session to stream
   * @param onEvent - Callback invoked for each agent event
   * @param options - Stream options (signal, reconnection settings)
   */
  async streamEvents(
    sessionId: string,
    onEvent: (event: AgentEvent) => void,
    options: StreamOptions = {},
  ): Promise<void> {
    const maxReconnects = options.maxReconnects ?? 5;
    const baseDelay = options.reconnectDelay ?? 1_000;
    const parser = new SSEParser();
    let reconnectCount = 0;

    while (reconnectCount <= maxReconnects) {
      // Check for cancellation before connecting
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }

      const headers: Record<string, string> = {
        ...this.authHeaders(),
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
      };

      // Include Last-Event-Id for reconnection
      const lastId = parser.getLastEventId();
      if (lastId) {
        headers["Last-Event-Id"] = lastId;
      }

      const url = `${this.serverUrl}/api/yuan-agent/stream?sessionId=${encodeURIComponent(sessionId)}`;

      let response: Response;
      try {
        response = await fetch(url, {
          method: "GET",
          headers,
          signal: options.signal,
        });
      } catch (err) {
        // Network error — attempt reconnection
        if (isAbortError(err)) throw err;
        reconnectCount++;
        if (reconnectCount > maxReconnects) {
          throw new CloudClientError(
            `SSE connection failed after ${maxReconnects} retries: ${errorMessage(err)}`,
            0,
          );
        }
        parser.reset();
        await sleep(baseDelay * Math.pow(2, reconnectCount - 1));
        continue;
      }

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new CloudClientError(
          `SSE stream error: ${response.status} ${response.statusText}`,
          response.status,
          body,
        );
      }

      if (!response.body) {
        throw new CloudClientError("SSE response has no body", 0);
      }

      // Read the stream
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let streamEnded = false;

      try {
        while (!done) {
          const result = await reader.read();
          done = result.done;

          if (result.value) {
            const text = decoder.decode(result.value, { stream: !done });
            const sseEvents = parser.feed(text);

            for (const sseEvent of sseEvents) {
              const kind = SSE_EVENT_MAP[sseEvent.event];
              if (!kind) continue; // Unknown event type — skip

              try {
                const payload = JSON.parse(sseEvent.data) as Record<string, unknown>;
                const agentEvent = { kind, ...payload } as AgentEvent;
                onEvent(agentEvent);

                // If we got a terminal event, mark stream as ended
                if (kind === "done" || kind === "error") {
                  streamEnded = true;
                }
              } catch {
                // Malformed JSON — skip this event
              }
            }
          }
        }
      } catch (err) {
        if (isAbortError(err)) throw err;

        // Stream read error — attempt reconnection unless stream already ended
        if (streamEnded) return;

        reconnectCount++;
        if (reconnectCount > maxReconnects) {
          throw new CloudClientError(
            `SSE stream read failed after ${maxReconnects} retries: ${errorMessage(err)}`,
            0,
          );
        }
        parser.reset();
        await sleep(baseDelay * Math.pow(2, reconnectCount - 1));
        continue;
      }

      // Stream completed normally
      return;
    }
  }

  /**
   * Approve or deny a pending action.
   *
   * @param sessionId - The session ID
   * @param actionId - The action to approve/deny
   * @param response - Approval decision
   */
  async approve(
    sessionId: string,
    actionId: string,
    response: ApprovalResponse,
  ): Promise<void> {
    await this.post("/api/yuan-agent/approve", {
      sessionId,
      actionId,
      ...response,
    });
  }

  /**
   * Stop a running session.
   *
   * @param sessionId - The session to stop
   */
  async stop(sessionId: string): Promise<void> {
    await this.post("/api/yuan-agent/stop", { sessionId });
  }

  /**
   * List all sessions for the authenticated user.
   */
  async listSessions(): Promise<SessionInfo[]> {
    return this.get<SessionInfo[]>("/api/yuan-agent/sessions");
  }

  /**
   * Get the current status of a session.
   *
   * @param sessionId - The session ID
   */
  async getStatus(sessionId: string): Promise<SessionStatus> {
    return this.get<SessionStatus>(
      `/api/yuan-agent/status?sessionId=${encodeURIComponent(sessionId)}`,
    );
  }

  /**
   * Stateless LLM chat call (no agent loop).
   *
   * @param messages - Conversation messages
   * @param options - LLM options (model, maxTokens, temperature, system prompt)
   */
  async llmChat(
    messages: LlmChatMessage[],
    options: LlmChatOptions = {},
  ): Promise<LlmChatResponse> {
    return this.post<LlmChatResponse>("/api/yuan-agent/llm/chat", {
      messages,
      ...options,
    });
  }

  // ─── Private Helpers ───

  /** Build auth headers. */
  private authHeaders(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
    };
  }

  /** Send a GET request and parse the JSON response. */
  private async get<T>(path: string): Promise<T> {
    const url = `${this.serverUrl}${path}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        ...this.authHeaders(),
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new CloudClientError(
        `GET ${path} failed: ${response.status} ${response.statusText}`,
        response.status,
        body,
      );
    }

    return (await response.json()) as T;
  }

  /** Send a POST request with a JSON body and parse the JSON response. */
  private async post<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.serverUrl}${path}`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new CloudClientError(
        `POST ${path} failed: ${response.status} ${response.statusText}`,
        response.status,
        text,
      );
    }

    // Some endpoints (stop, approve) may return 204 No Content
    const contentType = response.headers.get("content-type") ?? "";
    if (response.status === 204 || !contentType.includes("application/json")) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }
}

// ─── Utilities ───

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
