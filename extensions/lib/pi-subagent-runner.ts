import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionContext } from "@earendil-works/pi-coding-agent";

export const EXTENSION_KEY = "pi-as-subagent";
export const CONFIG_PATH = join(getAgentDir(), "pi-as-subagent.json");
export const DEFAULT_PROVIDER = "openai-codex";
export const DEFAULT_MODEL = "gpt-5.5";
export const DEFAULT_THINKING = "off";
export const DEFAULT_TIMEOUT_SECONDS = 120;
export const MAX_TIMEOUT_SECONDS = 1_800;
export const MAX_STDOUT_CHARS = 200_000;
export const MAX_STDERR_CHARS = 50_000;
export const CONFIG_CACHE_TTL_MS = 5_000;
export const AGENT_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;
export const DEFAULT_CONFIG = {
  oracle: {
    description:
      "Read-only second opinion for debugging, code review, and architecture questions.",
    system_prompt:
      "You are Oracle, a read-only second-opinion subagent. Help debug, review code, and reason about architecture when explicitly asked. Truth-seek: report only evidence-backed findings in concise Markdown, cite file paths, commands, logs, or links where relevant, distinguish facts from hypotheses, and state uncertainty. Do not modify files, run destructive actions, hallucinate, or fabricate information.",
    model: "gpt-5.5",
    provider: "openai-codex",
    thinking: "medium",
    timeout_seconds: 300,
  },
};

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export type RawSubagentConfig = {
  description?: unknown;
  system_prompt?: unknown;
  provider?: unknown;
  model?: unknown;
  thinking?: unknown;
  timeout_seconds?: unknown;
};

export type SubagentConfig = {
  name: string;
  description?: string;
  systemPrompt: string;
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  timeoutSeconds: number;
};

export type ConfigCache = {
  loadedAt: number;
  config: Map<string, SubagentConfig>;
};

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputExceeded?: "stdout" | "stderr";
};

function asTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function parseThinking(value: unknown): ThinkingLevel {
  const candidate = asTrimmedString(value);
  return THINKING_LEVELS.includes(candidate as ThinkingLevel)
    ? (candidate as ThinkingLevel)
    : DEFAULT_THINKING;
}

function parseTimeoutSeconds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(1, Math.round(value)));
}

export function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

export function defaultConfigText(): string {
  return `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`;
}

export function parseSubagentConfig(name: string, raw: unknown): SubagentConfig {
  if (!AGENT_NAME_RE.test(name)) {
    throw new Error(
      `Invalid subagent name ${JSON.stringify(name)}; expected ${AGENT_NAME_RE.source}`,
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Subagent ${name} must be an object`);
  }

  const block = raw as RawSubagentConfig;
  const systemPrompt = asTrimmedString(block.system_prompt);
  if (!systemPrompt) {
    throw new Error(`Subagent ${name} requires a non-empty system_prompt`);
  }

  return {
    name,
    description: asTrimmedString(block.description),
    systemPrompt,
    provider: asTrimmedString(block.provider) ?? DEFAULT_PROVIDER,
    model: asTrimmedString(block.model) ?? DEFAULT_MODEL,
    thinking: parseThinking(block.thinking),
    timeoutSeconds: parseTimeoutSeconds(block.timeout_seconds),
  };
}

export function loadSubagentConfig(
  options: {
    force?: boolean;
    cache?: ConfigCache;
    onDefaultConfigCreated?: () => void;
  } = {},
): { config: Map<string, SubagentConfig>; cache: ConfigCache } {
  const { force = false, cache, onDefaultConfigCreated } = options;
  if (!force && cache && Date.now() - cache.loadedAt < CONFIG_CACHE_TTL_MS) {
    return { config: cache.config, cache };
  }

  let rawText: string;
  try {
    rawText = readFileSync(CONFIG_PATH, "utf8");
  } catch (error) {
    if (!isNodeErrorWithCode(error, "ENOENT")) throw error;
    rawText = defaultConfigText();
    try {
      writeFileSync(CONFIG_PATH, rawText, { encoding: "utf8", flag: "wx" });
      onDefaultConfigCreated?.();
    } catch (writeError) {
      if (!isNodeErrorWithCode(writeError, "EEXIST")) throw writeError;
    }
  }

  const parsed = JSON.parse(rawText) as Record<string, unknown>;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${CONFIG_PATH} must contain a JSON object`);
  }

  const config = new Map<string, SubagentConfig>();
  for (const [name, raw] of Object.entries(parsed)) {
    config.set(name, parseSubagentConfig(name, raw));
  }

  const nextCache = { loadedAt: Date.now(), config };
  return { config, cache: nextCache };
}

export function formatAgentDescription(agent: SubagentConfig): string {
  const parts = [
    agent.description,
    `${agent.provider}/${agent.model}`,
    agent.thinking !== "off" ? `thinking=${agent.thinking}` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  return parts || `${agent.provider}/${agent.model}`;
}

export function extractMentionedAgents(
  text: string,
  config: Map<string, SubagentConfig>,
): string[] {
  const mentions = new Set<string>();
  for (const match of text.matchAll(/@#([A-Za-z][A-Za-z0-9_-]*)\b/g)) {
    const name = match[1]!;
    if (config.has(name)) mentions.add(name);
  }
  return [...mentions];
}

export function formatSubagentStatus(
  agent: SubagentConfig,
  startedAt: number,
  options: { spinner?: boolean } = {},
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - startedAt) / 1000),
  );
  const totalSeconds = Math.max(1, agent.timeoutSeconds);
  const ratio = Math.min(1, elapsedSeconds / totalSeconds);
  const width = 20;
  const partialBlocks = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
  const filledUnits = Math.min(width * 8, Math.floor(ratio * width * 8));
  const fullBlocks = Math.floor(filledUnits / 8);
  const partial = partialBlocks[filledUnits % 8] ?? "";
  const emptyBlocks = Math.max(0, width - fullBlocks - (partial ? 1 : 0));
  const bar = `${"█".repeat(fullBlocks)}${partial}${"░".repeat(emptyBlocks)}`;
  const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);
  const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][
    elapsedSeconds % 10
  ];
  const prefix = options.spinner === false ? "" : `${spinner} `;
  const thinkingText =
    agent.thinking === "off" ? "thinking off" : agent.thinking;
  return `${prefix}using @#${agent.name} · ${agent.model} • ${thinkingText} [${bar}] ${remainingSeconds}s left`;
}

export function buildSubagentPrompt(
  agent: SubagentConfig,
  prompt: string,
  context?: string,
): string {
  return [
    `You are the configured Pi subagent "${agent.name}".`,
    "Return a concise Markdown summary/advisory response for the calling agent.",
    "Cite concrete evidence such as file paths, command output, logs, or links when relevant.",
    "If information is uncertain or unavailable, say so explicitly.",
    "",
    "## Task",
    prompt.trim(),
    context?.trim()
      ? ["", "## Context from the calling agent", context.trim()].join("\n")
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function runConfiguredSubagent(
  agent: SubagentConfig,
  promptText: string,
  ctx: Pick<ExtensionContext, "cwd" | "signal">,
): Promise<SpawnResult> {
  return spawnPiSubagent(agent, promptText, ctx.cwd, ctx.signal);
}

export function spawnPiSubagent(
  agent: SubagentConfig,
  promptText: string,
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const tmpPromptDir = mkdtempSync(join(tmpdir(), "pi-subagent-"));
    const tmpPromptPath = join(tmpPromptDir, `${agent.name}-system-prompt.txt`);
    writeFileSync(tmpPromptPath, agent.systemPrompt, "utf8");
    const args = [
      "--provider",
      agent.provider,
      "--model",
      agent.model,
      "--thinking",
      agent.thinking,
      "--append-system-prompt",
      tmpPromptPath,
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "Answer the task provided on stdin.",
    ];
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let outputExceeded: SpawnResult["outputExceeded"];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const child = spawn("pi", args, {
      cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal?.removeEventListener("abort", abortHandler);
      try {
        rmSync(tmpPromptDir, { recursive: true, force: true });
      } catch {
        // Best-effort temp file cleanup.
      }
    };
    const terminate = () => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, 2_000);
      killTimer.unref();
    };
    const abortHandler = () => terminate();
    const appendLimited = (target: "stdout" | "stderr", chunk: string) => {
      const limit = target === "stdout" ? MAX_STDOUT_CHARS : MAX_STDERR_CHARS;
      const current = target === "stdout" ? stdout : stderr;
      if (current.length + chunk.length <= limit) {
        if (target === "stdout") stdout += chunk;
        else stderr += chunk;
        return;
      }
      const remaining = Math.max(0, limit - current.length);
      if (remaining > 0) {
        if (target === "stdout") stdout += chunk.slice(0, remaining);
        else stderr += chunk.slice(0, remaining);
      }
      outputExceeded = target;
      terminate();
    };

    if (signal?.aborted) terminate();
    else signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => appendLimited("stdout", chunk));
    child.stderr.on("data", (chunk: string) => appendLimited("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code, procSignal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        stdout,
        stderr,
        code,
        signal: procSignal,
        timedOut,
        outputExceeded,
      });
    });

    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, agent.timeoutSeconds * 1000);
    timer.unref();
    child.stdin.end(promptText);
  });
}
