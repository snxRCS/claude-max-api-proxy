/**
 * API Route Handlers
 *
 * Implements OpenAI-compatible endpoints for Clawdbot integration
 */

import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { ClaudeSubprocess } from "../subprocess/manager.js";
import { openaiToCli } from "../adapter/openai-to-cli.js";
import {
  cliResultToOpenai,
  createDoneChunk,
} from "../adapter/cli-to-openai.js";
import type { OpenAIChatRequest } from "../types/openai.js";
import type { ClaudeCliAssistant, ClaudeCliResult, ClaudeCliStreamEvent } from "../types/claude-cli.js";

/**
 * Handle POST /v1/chat/completions
 *
 * Main endpoint for chat requests, supports both streaming and non-streaming
 */
export async function handleChatCompletions(
  req: Request,
  res: Response
): Promise<void> {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  if (process.env.DEBUG === "true") {
    console.log("[DEBUG] Request Body:", JSON.stringify(req.body, null, 2));
  }
  const requestId = uuidv4().replace(/-/g, "").slice(0, 24);
  const body = req.body as OpenAIChatRequest;
  const stream = body.stream === true;

  try {
    // Validate request - allow either 'messages' or 'input'
    const messages = body.messages || body.input;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({
        error: {
          message: "messages or input is required and must be a non-empty array",
          type: "invalid_request_error",
          code: "invalid_messages",
        },
      });
      return;
    }

    // Convert to CLI input format
    const cliInput = openaiToCli(body);
    const subprocess = new ClaudeSubprocess();

    if (stream) {
      await handleStreamingResponse(req, res, subprocess, cliInput, requestId);
    } else {
      await handleNonStreamingResponse(res, subprocess, cliInput, requestId);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[handleChatCompletions] Error:", message);

    if (!res.headersSent) {
      res.status(500).json({
        error: {
          message,
          type: "server_error",
          code: null,
        },
      });
    }
  }
}

/**
 * Handle streaming response (SSE)
 *
 * IMPORTANT: The Express req.on("close") event fires when the request body
 * is fully received, NOT when the client disconnects. For SSE connections,
 * we use res.on("close") to detect actual client disconnection.
 */
async function handleStreamingResponse(
  req: Request,
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Request-Id", requestId);

  // CRITICAL: Flush headers immediately to establish SSE connection
  res.flushHeaders();

  let lastModel = "claude-sonnet-4";

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeatInterval = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": ping\n\n");
    }
  }, 15000);

  return new Promise<void>((resolve, reject) => {
    let isFirst = true;
    let isComplete = false;

    const cleanup = () => {
      clearInterval(heartbeatInterval);
      subprocess.off("start", onStart);
      subprocess.off("assistant", onAssistant);
      subprocess.off("content_delta", onContentDelta);
      subprocess.off("hook_response", onHookResponse);
      subprocess.off("result", onResult);
      subprocess.off("error", onError);
      subprocess.off("close", onClose);
      if (!isComplete) {
        subprocess.kill();
      }
      resolve();
    };

    const onStart = () => {
      if (isFirst && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              role: "assistant",
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    };

    const onAssistant = (message: ClaudeCliAssistant) => {
      lastModel = message.message.model;

      // Only forward aucky-spawn calls to prevent flooding
      for (const part of message.message.content) {
        if (part.type === "tool_use" && part.name === "Bash" && part.input?.command?.includes("aucky-spawn") && !res.writableEnded) {
          const toolText = `\n\n[Delegating Task]\n\`\`\`\n${part.input.command}\n\`\`\`\n`;
          const chunk = {
            id: `chatcmpl-${requestId}`,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: lastModel,
            choices: [{
              index: 0,
              delta: {
                content: toolText,
              },
              finish_reason: null,
            }],
          };
          res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        }
      }
    };

    const onHookResponse = (message: any) => {
      // Only forward results if they are related to aucky-spawn
      // Since we don't easily know which tool the hook belongs to here, 
      // we only forward if it looks like a subagent confirmation.
      if (!res.writableEnded && (message.output?.includes("OK") || message.output?.includes("queued"))) {
        const resultText = `\n[Status: ${message.outcome}]\n\`\`\`\n${message.output}\n\`\`\`\n`;
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              content: resultText,
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }
    };

    const onContentDelta = (event: ClaudeCliStreamEvent) => {
      const text = event.event.delta?.text || "";
      const thinking = event.event.delta?.thinking || "";
      
      if (process.env.DEBUG === "true") {
        if (text) console.error(`[DEBUG] content_delta (text): "${text.slice(0, 20)}..."`);
        if (thinking) console.error(`[DEBUG] content_delta (thinking): "${thinking.slice(0, 20)}..."`);
      }

      if ((text || thinking) && !res.writableEnded) {
        const chunk = {
          id: `chatcmpl-${requestId}`,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model: lastModel,
          choices: [{
            index: 0,
            delta: {
              ...(text ? { content: text } : {}),
              ...(thinking ? { reasoning_content: thinking } : {}),
            },
            finish_reason: null,
          }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        isFirst = false;
      }
    };

    const onResult = (result: ClaudeCliResult) => {
      isComplete = true;
      if (!res.writableEnded) {
        const doneChunk = createDoneChunk(requestId, lastModel, result.usage);
        res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
    };

    const onError = (error: Error) => {
      console.error("[Streaming] Error:", error.message);
      if (!res.writableEnded) {
        res.write(
          `data: ${JSON.stringify({
            error: { message: error.message, type: "server_error", code: null },
          })}\n\n`
        );
        res.end();
      }
      cleanup();
    };

    const onClose = (code: number | null) => {
      if (!res.writableEnded) {
        if (code !== 0 && !isComplete) {
          res.write(`data: ${JSON.stringify({
            error: { message: `Process exited with code ${code}`, type: "server_error", code: null },
          })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
    };

    subprocess.on("start", onStart);
    subprocess.on("assistant", onAssistant);
    subprocess.on("content_delta", onContentDelta);
    subprocess.on("hook_response", onHookResponse);
    subprocess.on("result", onResult);
    subprocess.on("error", onError);
    subprocess.on("close", onClose);

    res.on("close", () => {
      cleanup();
    });

    // Start the subprocess
    subprocess.start(cliInput.prompt, {
      model: cliInput.model,
      sessionId: cliInput.sessionId,
    }).catch((err) => {
      console.error("[Streaming] Subprocess start error:", err);
      if (!res.writableEnded) {
        // Headers already flushed as SSE — must use SSE error format
        res.write(`data: ${JSON.stringify({ error: { message: err.message, type: "server_error", code: null } })}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      }
      cleanup();
    });
  });
}

/**
 * Handle non-streaming response
 */
async function handleNonStreamingResponse(
  res: Response,
  subprocess: ClaudeSubprocess,
  cliInput: ReturnType<typeof openaiToCli>,
  requestId: string
): Promise<void> {
  return new Promise((resolve) => {
    let finalResult: ClaudeCliResult | null = null;

    subprocess.on("result", (result: ClaudeCliResult) => {
      finalResult = result;
    });

    subprocess.on("error", (error: Error) => {
      console.error("[NonStreaming] Error:", error.message);
      res.status(500).json({
        error: {
          message: error.message,
          type: "server_error",
          code: null,
        },
      });
      resolve();
    });

    subprocess.on("close", (code: number | null) => {
      if (finalResult) {
        res.json(cliResultToOpenai(finalResult, requestId));
      } else if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Claude CLI exited with code ${code} without response`,
            type: "server_error",
            code: null,
          },
        });
      }
      resolve();
    });

    // Start the subprocess
    subprocess
      .start(cliInput.prompt, {
        model: cliInput.model,
        sessionId: cliInput.sessionId,
      })
      .catch((error) => {
        res.status(500).json({
          error: {
            message: error.message,
            type: "server_error",
            code: null,
          },
        });
        resolve();
      });
  });
}

/**
 * Handle GET /v1/models
 *
 * Returns available models
 */
export function handleModels(_req: Request, res: Response): void {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-opus-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-sonnet-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
      {
        id: "claude-haiku-4",
        object: "model",
        owned_by: "anthropic",
        created: Math.floor(Date.now() / 1000),
      },
    ],
  });
}

/**
 * Handle GET /health
 *
 * Health check endpoint
 */
export function handleHealth(_req: Request, res: Response): void {
  res.json({
    status: "ok",
    provider: "claude-code-cli",
    timestamp: new Date().toISOString(),
  });
}
