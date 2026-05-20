// LLM API client (OpenAI-compatible) with agentic tool-use loop

import type {
  AuditLogEntry,
  LlmMessage,
  LlmResponse,
  LlmToolCall,
  LlmToolDefinition,
} from "./types.ts";
import type { Logger } from "./logger.ts";
import type { FetchFn } from "./github.ts";

export interface LlmClientOptions {
  baseUrl: string;
  model: string;
  apiKey: string | undefined;
  fetchFn?: FetchFn;
}

export interface AgentLoopOptions {
  stage: 1 | 2;
  prNumber: number | string | null;
  /** Called for each tool call; returns the tool result string. */
  toolExecutor?: (toolName: string, toolArgs: Record<string, unknown>) => Promise<string>;
  /** Maximum turns (tool-use round trips) before giving up. */
  maxTurns?: number;
  logger?: Logger;
}

export interface AgentLoopResult {
  /** The final text content from the model. */
  content: string;
  /** Total turns executed (including the final non-tool turn). */
  turns: number;
}

export class LlmClient {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly headers: Record<string, string>;
  private readonly fetchFn: FetchFn;

  constructor(options: LlmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
    this.fetchFn = options.fetchFn ?? fetch;
    this.headers = {
      "Content-Type": "application/json",
      ...(options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {}),
    };
  }

  /**
   * Run a single (non-agentic) completion call.
   */
  async complete(
    messages: LlmMessage[],
    options: AgentLoopOptions,
  ): Promise<AgentLoopResult> {
    return this.runLoop(messages, [], options);
  }

  /**
   * Run an agentic completion loop with optional tool use.
   * Continues calling the model until it produces a response without tool calls.
   */
  async runLoop(
    initialMessages: LlmMessage[],
    tools: LlmToolDefinition[],
    options: AgentLoopOptions,
  ): Promise<AgentLoopResult> {
    const maxTurns = options.maxTurns ?? 20;
    const messages: LlmMessage[] = [...initialMessages];
    let turn = 0;

    while (turn < maxTurns) {
      turn++;
      const startTime = Date.now();

      let response: LlmResponse;
      let logEntry: AuditLogEntry;

      try {
        response = await this.callApi(messages, tools);
      } catch (err) {
        // Log the error and rethrow
        if (options.logger) {
          logEntry = {
            timestamp: new Date().toISOString(),
            stage: options.stage,
            pr_number: options.prNumber,
            model: this.model,
            base_url: this.baseUrl,
            turn,
            messages_sent: messages,
            tool_calls: [],
            response_received: { error: String(err) },
            tokens_used: { input: 0, output: 0 },
            duration_ms: Date.now() - startTime,
          };
          await options.logger.append(logEntry);
        }
        throw new Error(`LLM API error: ${err}`);
      }

      const choice = response.choices[0];
      const toolCalls: LlmToolCall[] = choice.message.tool_calls ?? [];

      logEntry = {
        timestamp: new Date().toISOString(),
        stage: options.stage,
        pr_number: options.prNumber,
        model: this.model,
        base_url: this.baseUrl,
        turn,
        messages_sent: messages,
        tool_calls: toolCalls,
        response_received: response,
        tokens_used: {
          input: response.usage?.prompt_tokens ?? 0,
          output: response.usage?.completion_tokens ?? 0,
        },
        duration_ms: Date.now() - startTime,
      };

      if (options.logger) {
        await options.logger.append(logEntry);
      }

      // If no tool calls, this is the final response
      if (toolCalls.length === 0) {
        const content = choice.message.content ?? "";
        return { content, turns: turn };
      }

      // Add assistant message with tool calls
      messages.push({
        role: "assistant",
        content: choice.message.content,
        tool_calls: toolCalls,
      });

      // Execute all tool calls and add results
      for (const toolCall of toolCalls) {
        let result: string;
        if (options.toolExecutor) {
          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(toolCall.function.arguments);
          } catch {
            args = {};
          }
          result = await options.toolExecutor(toolCall.function.name, args);
        } else {
          result = `Tool "${toolCall.function.name}" is not available.`;
        }

        messages.push({
          role: "tool",
          content: result,
          tool_call_id: toolCall.id,
        });
      }
    }

    throw new Error(`LLM agentic loop exceeded maximum turns (${maxTurns})`);
  }

  private async callApi(
    messages: LlmMessage[],
    tools: LlmToolDefinition[],
  ): Promise<LlmResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
    };
    if (tools.length > 0) {
      body["tools"] = tools;
    }

    const res = await this.fetchFn(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text}`);
    }

    return res.json() as Promise<LlmResponse>;
  }
}
