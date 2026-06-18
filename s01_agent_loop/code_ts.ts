#!/usr/bin/env node
/**
 * s01_agent_loop.ts - The Agent Loop (TypeScript Implementation)
 *
 * The entire secret of an AI coding agent in one pattern:
 *
 *     while (stop_reason === "tool_use") {
 *         response = LLM(messages, tools)
 *         execute tools
 *         append results
 *     }
 *
 *     +----------+      +-------+      +---------+
 *     |   User   | ---> |  LLM  | ---> |  Tool   |
 *     |  prompt  |      |       |      | execute |
 *     +----------+      +---+---+      +----+----+
 *                           ^               |
 *                           |   tool_result |
 *                           +---------------+
 *                           (loop continues)
 *
 * Usage:
 *     npm install @anthropic-ai/sdk dotenv
 *     ANTHROPIC_API_KEY=... npx ts-node s01_agent_loop/code_ts.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";

// Load environment variables
dotenv.config({ override: true });

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";
const SYSTEM = `You are a coding agent at ${process.cwd()}. Use bash to solve tasks. Act, don't explain.`;

// ── Tool definition: just bash ────────────────────────────
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute",
        },
      },
      required: ["command"],
    },
  },
];

// ── Types ──────────────────────────────────────────────────
interface ToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type MessageContent = string | Anthropic.ContentBlock[];

interface Message {
  role: "user" | "assistant";
  content: MessageContent;
}

// ── Tool execution ────────────────────────────────────────
function runBash(command: string): string {
  // Dangerous command blacklist
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const output = execSync(command, {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120000, // 120 seconds timeout
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });
    return output.trim() || "(no output)";
  } catch (error: unknown) {
    if (error instanceof Error) {
      const execError = error as Error & { stderr?: string; stdout?: string };
      const output = (execError.stdout || "") + (execError.stderr || "");
      if (output) {
        return output.trim().slice(0, 50000);
      }
      return `Error: ${execError.message}`;
    }
    return "Error: Unknown error occurred";
  }
}

// ── The core pattern: a while loop that calls tools until the model stops ──
async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // 1. Call LLM with messages and tools
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as Anthropic.MessageParam[],
      tools: TOOLS,
      max_tokens: 8000,
    });

    // 2. Append assistant response to messages
    // IMPORTANT: Always append first, then check stop_reason
    // This ensures the assistant message is recorded for both:
    // - Tool use cases (need the tool_use_id for matching)
    // - End turn cases (need the final response for context)
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 3. Check if model wants to continue using tools
    // If not using tools, exit the inner loop
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 4. Execute each tool call and collect results
    const results: ToolResult[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const command = (block.input as { command: string }).command;

        // Print the command being executed (yellow color)
        console.log(`\x1b[33m$ ${command}\x1b[0m`);

        // Execute the bash command
        const output = runBash(command);

        // Print truncated output (first 200 chars)
        console.log(output.slice(0, 200));

        // Collect tool result with matching tool_use_id
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: output,
        });
      }
    }

    // 5. Feed tool results back as user message, loop continues
    messages.push({
      role: "user",
      content: results,
    });
  }
}

// ── Entry point with outer loop for multi-turn conversation ──
async function main(): Promise<void> {
  console.log("s01: Agent Loop (TypeScript)");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  // Create readline interface for user input
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // History stores all messages across multiple user inputs
  const history: Message[] = [];

  // Outer loop: handles multiple rounds of conversation
  while (true) {
    // Prompt user for input (cyan color)
    const query = await new Promise<string>((resolve) => {
      rl.question("\x1b[36ms01 >> \x1b[0m", resolve);
    });

    // Check exit conditions
    const normalizedQuery = query.trim().toLowerCase();
    if (normalizedQuery === "q" || normalizedQuery === "exit" || normalizedQuery === "") {
      break;
    }

    // Add user message to history
    history.push({
      role: "user",
      content: query,
    });

    // Inner loop: handles multiple tool calls for single user input
    await agentLoop(history);

    // Print the model's final text response
    const lastContent = history[history.length - 1].content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }
    }

    console.log();
  }

  rl.close();
}

// Run the main function
main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

/**
 * ── Summary: Double While Loop Structure ─────────────────────────
 *
 * OUTER WHILE LOOP (main function):
 *   - Purpose: Handle multiple rounds of user conversation
 *   - Trigger: Program starts
 *   - Exit: User inputs "q", "exit", or empty string
 *
 * INNER WHILE LOOP (agentLoop function):
 *   - Purpose: Handle multiple tool calls for single user input
 *   - Trigger: User submits a question
 *   - Exit: response.stop_reason !== "tool_use"
 *
 * ── Example: User inputs "创建 hello.py 并运行" ────────────────────
 *
 * Round 1 (Inner Loop):
 *   LLM → tool_use(bash: echo 'print("Hello")' > hello.py)
 *   → Execute → tool_result: "(no output)"
 *   → Continue loop
 *
 * Round 2 (Inner Loop):
 *   LLM → tool_use(bash: python hello.py)
 *   → Execute → tool_result: "Hello!"
 *   → Continue loop
 *
 * Round 3 (Inner Loop):
 *   LLM → text: "已完成创建和运行"
 *   → stop_reason: "end_turn"
 *   → Exit inner loop
 *
 * Print final response, then outer loop continues waiting for next input
 */