#!/usr/bin/env node
/**
 * s02_tool_use.ts - Tool Use (TypeScript Implementation)
 *
 * Based on s01's agent loop, adds 4 new tools + dispatch mapping.
 *
 * Changes from s01:
 *   + run_read / run_write / run_edit / run_glob implementations
 *   + TOOL_HANDLERS dispatch map (replaces s01's hardcoded run_bash)
 *   + safe_path path validation
 *
 * The agent_loop structure remains unchanged from s01.
 *
 * Usage:
 *     npm install @anthropic-ai/sdk dotenv ts-node
 *     ANTHROPIC_API_KEY=... npx ts-node s02_tool_use/code_ts.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import * as dotenv from "dotenv";
import { execSync } from "child_process";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import { glob as globSync } from "glob";

// Load environment variables
dotenv.config({ override: true });

// Initialize Anthropic client
const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseURL: process.env.ANTHROPIC_BASE_URL,
});

const WORKDIR = process.cwd();
const MODEL = process.env.MODEL_ID || "claude-sonnet-4-6";
const SYSTEM = `You are a coding agent at ${WORKDIR}. Use tools to solve tasks. Act, don't explain.`;

// ── Tool Definition Schema (JSON Schema for LLM) ────────────
// TOOLS: 给 LLM 看的 JSON Schema，告诉模型"有哪些工具可用、参数是什么"

interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

const TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to execute" },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to read" },
        limit: { type: "integer", description: "Max number of lines to read" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in a file once.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "The file path to edit" },
        old_text: { type: "string", description: "The text to replace" },
        new_text: { type: "string", description: "The new text" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "The glob pattern (e.g., *.py)" },
      },
      required: ["pattern"],
    },
  },
];

// ── Tool Handlers (Execution Functions for Program) ──────────
// TOOL_HANDLERS: 给程序用的执行函数映射表，工具名 → 执行函数

type ToolHandler = (input: Record<string, unknown>) => string;

// ═══════════════════════════════════════════════════════════
//  FROM s01 (unchanged)
// ═══════════════════════════════════════════════════════════

function runBash(input: Record<string, unknown>): string {
  const command = input.command as string;

  // Dangerous command blacklist
  const dangerous = ["rm -rf /", "sudo", "shutdown", "reboot", "> /dev/"];
  if (dangerous.some((d) => command.includes(d))) {
    return "Error: Dangerous command blocked";
  }

  try {
    const output = execSync(command, {
      cwd: WORKDIR,
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

// ═══════════════════════════════════════════════════════════
//  NEW in s02: safe_path + 4 new tools
// ═══════════════════════════════════════════════════════════

/**
 * safe_path: Validate that path doesn't escape workspace
 * Prevents path traversal attacks like "../../../etc/passwd"
 */
function safePath(p: string): string {
  const resolvedPath = path.resolve(WORKDIR, p);
  if (!resolvedPath.startsWith(WORKDIR)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolvedPath;
}

/**
 * read_file: Read file contents with optional line limit
 */
function runRead(input: Record<string, unknown>): string {
  try {
    const filePath = safePath(input.path as string);
    const limit = input.limit as number | undefined;

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");

    if (limit && limit < lines.length) {
      const truncatedLines = lines.slice(0, limit);
      truncatedLines.push(`... (${lines.length - limit} more lines)`);
      return truncatedLines.join("\n");
    }

    return lines.join("\n");
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return "Error: Unknown error";
  }
}

/**
 * write_file: Write content to file, creating parent dirs if needed
 */
function runWrite(input: Record<string, unknown>): string {
  try {
    const filePath = safePath(input.path as string);
    const content = input.content as string;

    // Create parent directories if needed
    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${input.path}`;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return "Error: Unknown error";
  }
}

/**
 * edit_file: Replace exact text in file once
 */
function runEdit(input: Record<string, unknown>): string {
  try {
    const filePath = safePath(input.path as string);
    const oldText = input.old_text as string;
    const newText = input.new_text as string;

    const content = fs.readFileSync(filePath, "utf-8");

    if (!content.includes(oldText)) {
      return `Error: text not found in ${input.path}`;
    }

    // Replace only the first occurrence
    const newContent = content.replace(oldText, newText);
    fs.writeFileSync(filePath, newContent, "utf-8");

    return `Edited ${input.path}`;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return "Error: Unknown error";
  }
}

/**
 * glob: Find files matching glob pattern
 */
function runGlob(input: Record<string, unknown>): string {
  try {
    const pattern = input.pattern as string;

    // Use glob package to find matching files
    const matches = globSync.sync(pattern, {
      cwd: WORKDIR,
      nodir: true, // Only files, not directories
    });

    // Filter to ensure all matches are within workspace
    const safeMatches = matches.filter((match) => {
      const resolvedPath = path.resolve(WORKDIR, match);
      return resolvedPath.startsWith(WORKDIR);
    });

    if (safeMatches.length === 0) {
      return "(no matches)";
    }

    return safeMatches.join("\n");
  } catch (error: unknown) {
    if (error instanceof Error) {
      return `Error: ${error.message}`;
    }
    return "Error: Unknown error";
  }
}

// ═══════════════════════════════════════════════════════════
//  NEW in s02: Tool dispatch map
//  s01: hardcoded run_bash
//  s02: TOOL_HANDLERS lookup
// ═══════════════════════════════════════════════════════════

const TOOL_HANDLERS: Record<string, ToolHandler> = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
  glob: runGlob,
};

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

// ═══════════════════════════════════════════════════════════
//  agent_loop — 与 s01 结构完全一致，只改了工具执行那部分
//  s01: output = run_bash(block.input["command"])
//  s02: output = TOOL_HANDLERS[block.name](**block.input)
// ═══════════════════════════════════════════════════════════

async function agentLoop(messages: Message[]): Promise<void> {
  while (true) {
    // 1. Call LLM with messages and tools
    const response = await client.messages.create({
      model: MODEL,
      system: SYSTEM,
      messages: messages as Anthropic.MessageParam[],
      tools: TOOLS as Anthropic.Tool[],
      max_tokens: 8000,
    });

    // 2. Append assistant response to messages
    // IMPORTANT: Always append first, then check stop_reason
    messages.push({
      role: "assistant",
      content: response.content,
    });

    // 3. Check if model wants to continue using tools
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 4. Execute each tool call (serial execution in teaching version)
    const results: ToolResult[] = [];
    for (const block of response.content) {
      // Only process tool_use blocks
      // text/thinking blocks don't need execution - they're already in messages
      if (block.type === "tool_use") {
        // Print tool name being executed (yellow color)
        console.log(`\x1b[33m> ${block.name}\x1b[0m`);

        // Tool dispatch: lookup handler by name
        const handler = TOOL_HANDLERS[block.name];
        const output = handler ? handler(block.input as Record<string, unknown>) : `Unknown tool: ${block.name}`;

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
  console.log("s02: Tool Use — TypeScript Version");
  console.log("输入问题，回车发送。输入 q 退出。\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const history: Message[] = [];

  // Outer loop: handles multiple rounds of conversation
  while (true) {
    // Prompt user for input (cyan color)
    const query = await new Promise<string>((resolve) => {
      rl.question("\x1b[36ms02 >> \x1b[0m", resolve);
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

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});

/**
 * ── Summary: Tool Dispatch Architecture ─────────────────────────
 *
 * TOOLS (JSON Schema):
 *   - Purpose: Tell LLM what tools are available and their parameters
 *   - Used by: LLM (declarative)
 *   - Content: JSON Schema objects
 *
 * TOOL_HANDLERS (Function Map):
 *   - Purpose: Map tool names to execution functions
 *   - Used by: Program (executable)
 *   - Content: TypeScript functions
 *
 * ── Adding a New Tool ───────────────────────────────────────────
 *
 * Step 1: Add to TOOLS array (JSON Schema)
 *   TOOLS.push({
 *     name: "new_tool",
 *     description: "What this tool does",
 *     input_schema: { type: "object", properties: {...}, required: [...] }
 *   })
 *
 * Step 2: Add to TOOL_HANDLERS map (Function)
 *   TOOL_HANDLERS["new_tool"] = runNewTool
 *
 * Step 3: Implement the handler function
 *   function runNewTool(input: Record<string, unknown>): string {
 *     // Implementation...
 *   }
 *
 * ── Tool Execution Flow ──────────────────────────────────────────
 *
 * for block in response.content:
 *     if block.type == "tool_use":        # Only process tool_use
 *         handler = TOOL_HANDLERS[block.name]  # Lookup
 *         output = handler(block.input)        # Execute
 *         results.append(tool_result)          # Collect
 *
 * - text/thinking blocks don't need execution (already in messages)
 * - Teaching version: serial execution (for loop)
 * - Claude Code: parallel execution (batch algorithm)
 */