/**
 * Converts OpenAI chat request format to Claude CLI input
 */

import type { OpenAIChatRequest } from "../types/openai.js";

export type ClaudeModel = "opus" | "sonnet" | "haiku";

export interface CliInput {
  prompt: string;
  model: ClaudeModel;
  sessionId?: string;
}

const MODEL_MAP: Record<string, ClaudeModel> = {
  // Direct model names
  "claude-opus-4": "opus",
  "claude-sonnet-4": "sonnet",
  "claude-haiku-4": "haiku",
  // With provider prefix
  "claude-code-cli/claude-opus-4": "opus",
  "claude-code-cli/claude-sonnet-4": "sonnet",
  "claude-code-cli/claude-haiku-4": "haiku",
  // Aliases
  "opus": "opus",
  "sonnet": "sonnet",
  "haiku": "haiku",
};

/**
 * Extract Claude model alias from request model string
 */
export function extractModel(model: string): ClaudeModel {
  // Try direct lookup
  if (MODEL_MAP[model]) {
    return MODEL_MAP[model];
  }

  // Try stripping provider prefix (claude-code-cli/ or claude-max/)
  const stripped = model.replace(/^(claude-code-cli|claude-max)\//, "");
  if (MODEL_MAP[stripped]) {
    return MODEL_MAP[stripped];
  }

  // Default to opus (Claude Max subscription)
  return "opus";
}

/**
 * Extract text from a message content field.
 * Handles both plain string and OpenAI array-of-parts format:
 *   "hello"  OR  [{"type":"text","text":"hello"}, {"type":"image_url",...}]
 */
function extractContent(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .filter((part) => (part.type === "text" || part.type === "input_text") && typeof (part.text || part.input_text) === "string")
      .map((part) => part.text || part.input_text)
      .join("\n");
  }
  return String(content ?? "");
}

/**
 * Convert OpenAI messages array to a single prompt string for Claude CLI
 *
 * Claude Code CLI in --print mode expects a single prompt, not a conversation.
 * We format the messages into a readable format that preserves context.
 */
export function messagesToPrompt(messages: any[]): string {
  const parts: string[] = [];

  // Add OpenClaw Bridge instructions
  parts.push(`
<openclaw_bridge>
## YOUR ROLE: LEAD DELEGATOR & ORCHESTRATOR
Your primary goal is to manage the infrastructure by delegating work to specialized subagents. 
The user is the FINAL DECISION MAKER. 

### EXECUTION PATTERN:
1. **Analyze & Plan:** Break down the user's request into logical sub-tasks.
2. **Confirm:** Present the plan to the user and wait for their "Go".
3. **Delegate:** Use 'aucky-spawn' to start a separate task for each sub-task.
4. **Monitor:** You can use 'subagents list' or check other sessions to keep track, but let the subagents report their results directly to the user.

### MANDATORY TOOL: aucky-spawn
To spawn a real OpenClaw subagent (which the user can see in Telegram as a separate task), use the following bash command:
aucky-spawn "The detailed message/task for the subagent"

Example for parallel execution:
aucky-spawn "Configure pfSense VLANs" & aucky-spawn "Configure HAProxy" & wait

IMPORTANT: 
- ALWAYS prefer subagents for any actual work. 
- You act as the brain that coordinates everything.
- You are allowed to steer or kill subagents if you decide it is necessary, but the user is the ultimate boss.
</openclaw_bridge>
`);

  for (const msg of messages) {
    const text = extractContent(msg.content);
    switch (msg.role) {
      case "system":
        // System messages become context instructions
        parts.push(`<system>\n${text}\n</system>\n`);
        break;

      case "user":
        // User messages are the main prompt
        parts.push(text);
        break;

      case "assistant":
        // Previous assistant responses for context
        parts.push(`<previous_response>\n${text}\n</previous_response>\n`);
        break;
    }
  }

  return parts.join("\n").trim();
}

/**
 * Convert OpenAI chat request to CLI input format
 */
export function openaiToCli(request: OpenAIChatRequest): CliInput {
  const messages = request.messages || request.input || [];
  return {
    prompt: messagesToPrompt(messages),
    model: extractModel(request.model),
    sessionId: request.user, // Use OpenAI's user field for session mapping
  };
}
