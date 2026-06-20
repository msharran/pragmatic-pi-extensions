import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
  CONFIG_PATH,
  buildSubagentPrompt,
  extractMentionedAgents,
  formatAgentDescription,
  formatSubagentStatus,
  loadSubagentConfig,
  runConfiguredSubagent,
  type ConfigCache,
  type SubagentConfig,
  isNodeErrorWithCode,
  MAX_STDERR_CHARS,
  MAX_STDOUT_CHARS,
} from "./lib/pi-subagent-runner";

const LOG_PATH = join(getAgentDir(), "pi-as-subagent.log");

let configCache: ConfigCache | undefined;

function writeLog(event: string, details: string): void {
  try {
    appendFileSync(
      LOG_PATH,
      `[${new Date().toISOString()}] ${event}: ${details}\n`,
      "utf8",
    );
  } catch {
    // Logging must never break the extension.
  }
}

function loadConfig(force = false): Map<string, SubagentConfig> {
  try {
    const result = loadSubagentConfig({
      force,
      cache: configCache,
      onDefaultConfigCreated: () => {
        writeLog("config:created_default", `path=${CONFIG_PATH}`);
      },
    });
    configCache = result.cache;
    writeLog(
      "config:loaded",
      `path=${CONFIG_PATH} agents=${[...result.config.keys()].join(",") || "<none>"}`,
    );
    return result.config;
  } catch (error) {
    if (!isNodeErrorWithCode(error, "EEXIST")) throw error;
    const result = loadSubagentConfig({ force: true, cache: configCache });
    configCache = result.cache;
    return result.config;
  }
}

function loadConfigSafe(): Map<string, SubagentConfig> {
  try {
    return loadConfig();
  } catch (error) {
    writeLog(
      "config:failed",
      error instanceof Error ? error.message : String(error),
    );
    return new Map();
  }
}

function agentAutocompleteItems(
  config: Map<string, SubagentConfig>,
  query: string,
): AutocompleteItem[] {
  const agents = [...config.values()];
  const matched = query.trim()
    ? fuzzyFilter(
        agents,
        query,
        (agent) =>
          `${agent.name} ${agent.description ?? ""} ${agent.provider} ${agent.model}`,
      )
    : agents;
  return matched.slice(0, 50).map((agent) => ({
    value: `@#${agent.name}`,
    label: `@#${agent.name}  ${formatAgentDescription(agent)}`,
  }));
}

function createSubagentAutocompleteProvider(
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    triggerCharacters: ["#"],
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const line = lines[cursorLine] ?? "";
      const beforeCursor = line.slice(0, cursorCol);
      const match = beforeCursor.match(/(?:^|[ \t])@#([^\s@#]*)$/);
      if (!match)
        return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const config = loadConfigSafe();
      if (options.signal.aborted || config.size === 0)
        return current.getSuggestions(lines, cursorLine, cursorCol, options);

      const query = match[1] ?? "";
      return {
        items: agentAutocompleteItems(config, query),
        prefix: `@#${query}`,
      };
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      return current.applyCompletion(
        lines,
        cursorLine,
        cursorCol,
        item,
        prefix,
      );
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      );
    },
  };
}

export default function piAsSubagentExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_pi_subagent",
    label: "Ask Subagent",
    description:
      "Ask a configured Pi subagent, return its summary, and take follow-up actions based on the user's prompt.",
    promptSnippet: "Ask a configured Pi subagent such as @#oracle",
    promptGuidelines: [
      "Use ask_pi_subagent when the user explicitly asks to consult, ask, review with, or use a configured @#name Pi subagent.",
      "Include concrete files, diffs, logs, commands, and findings already known to the main agent in ask_pi_subagent prompt or context.",
      "Treat ask_pi_subagent output as advisory; verify it, then take follow-up actions according to the user's prompt.",
    ],
    parameters: Type.Object({
      agent: Type.String({
        description: "Configured subagent name, e.g. oracle",
      }),
      prompt: Type.String({
        description: "The exact task/question for the subagent",
      }),
      context: Type.Optional(
        Type.String({
          description:
            "Optional extra context already gathered by the main agent",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      let config: Map<string, SubagentConfig>;
      try {
        config = loadConfig(true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeLog("tool:config_error", message);
        return {
          content: [
            { type: "text", text: `ask_pi_subagent config error: ${message}` },
          ],
          isError: true,
        };
      }

      const name =
        typeof params.agent === "string"
          ? params.agent.replace(/^@#?/, "").trim()
          : "";
      const prompt =
        typeof params.prompt === "string" ? params.prompt.trim() : "";
      const context =
        typeof params.context === "string" ? params.context.trim() : undefined;
      const agent = config.get(name);
      if (!agent) {
        const known =
          [...config.keys()].map((item) => `@#${item}`).join(", ") || "<none>";
        writeLog(
          "tool:unknown_agent",
          `agent=${name || "<empty>"} known=${known}`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Unknown Pi subagent: ${params.agent}. Known agents: ${known}`,
            },
          ],
          isError: true,
        };
      }
      if (!prompt) {
        return {
          content: [
            {
              type: "text",
              text: "ask_pi_subagent requires a non-empty prompt.",
            },
          ],
          isError: true,
        };
      }

      const fullPrompt = buildSubagentPrompt(agent, prompt, context);
      const commandPreview = `pi --provider ${agent.provider} --model ${agent.model} --thinking ${agent.thinking} --append-system-prompt <${agent.name}.system_prompt> -p --no-session --no-extensions --no-skills --no-prompt-templates --no-context-files <stdin>`;
      writeLog(
        "tool:start",
        `agent=${agent.name} cwd=${ctx.cwd} timeout=${agent.timeoutSeconds}s cmd=${commandPreview} promptChars=${fullPrompt.length}`,
      );
      const startedAt = Date.now();
      let statusTimer: ReturnType<typeof setInterval> | undefined;
      const updateStatus = () => {
        const statusText = formatSubagentStatus(agent, startedAt, {
          spinner: false,
        });
        ctx.ui.setWorkingVisible(true);
        ctx.ui.setWorkingMessage(statusText);
      };
      updateStatus();
      statusTimer = setInterval(updateStatus, 1_000);

      try {
        const spawned = await runConfiguredSubagent(agent, fullPrompt, {
          cwd: ctx.cwd,
          signal,
        });
        const output = spawned.stdout.trim();
        const stderr = spawned.stderr.trim();
        if (spawned.timedOut) {
          writeLog(
            "tool:timeout",
            `agent=${agent.name} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent timed out after ${agent.timeoutSeconds}s.`,
              },
            ],
            isError: true,
            details: { stderr },
          };
        }
        if (spawned.outputExceeded) {
          const limit =
            spawned.outputExceeded === "stdout"
              ? MAX_STDOUT_CHARS
              : MAX_STDERR_CHARS;
          writeLog(
            "tool:output_exceeded",
            `agent=${agent.name} stream=${spawned.outputExceeded} limit=${limit}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent ${spawned.outputExceeded} exceeded ${limit} characters for @#${agent.name}.`,
              },
            ],
            isError: true,
            details: {
              stdout: spawned.stdout,
              stderr,
              outputExceeded: spawned.outputExceeded,
              limit,
            },
          };
        }
        if (spawned.code !== 0) {
          writeLog(
            "tool:exit_nonzero",
            `agent=${agent.name} code=${spawned.code} signal=${spawned.signal ?? "<none>"} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent failed for @#${agent.name}: ${stderr || `exit code ${spawned.code}`}`,
              },
            ],
            isError: true,
            details: { code: spawned.code, signal: spawned.signal, stderr },
          };
        }
        if (!output) {
          writeLog(
            "tool:empty",
            `agent=${agent.name} stderr=${stderr || "<none>"}`,
          );
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent returned empty output for @#${agent.name}.`,
              },
            ],
            isError: true,
            details: { stderr },
          };
        }
        writeLog("tool:ok", `agent=${agent.name} outputChars=${output.length}`);
        return {
          content: [{ type: "text", text: output }],
          details: { agent: agent.name, stderr: stderr || undefined },
        };
      } catch (error) {
        if (signal?.aborted) {
          writeLog("tool:aborted", `agent=${agent.name}`);
          return {
            content: [
              {
                type: "text",
                text: `ask_pi_subagent aborted for @#${agent.name}.`,
              },
            ],
            isError: true,
          };
        }
        const message = error instanceof Error ? error.message : String(error);
        writeLog("tool:spawn_error", `agent=${agent.name} message=${message}`);
        return {
          content: [
            {
              type: "text",
              text: `ask_pi_subagent spawn failed for @#${agent.name}: ${message}`,
            },
          ],
          isError: true,
        };
      } finally {
        if (statusTimer) clearInterval(statusTimer);
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingVisible(true);
      }
    },
  });

  pi.on("input", async (event) => {
    if (event.source === "extension") return { action: "continue" };
    const config = loadConfigSafe();
    if (config.size === 0) return { action: "continue" };

    const agents = extractMentionedAgents(event.text, config);
    if (agents.length === 0) return { action: "continue" };

    const refs = agents.map((name) => `@#${name}`).join(", ");
    const directive = [
      `The user referenced Pi subagent(s): ${refs}.`,
      "If the user explicitly asks to consult, ask, review with, or use one of them, call ask_pi_subagent with the matching subagent name and the exact question/task.",
      "Do not call a subagent just because it is mentioned without a request.",
    ].join(" ");

    return {
      action: "transform",
      text: `${event.text}\n\n${directive}`,
    };
  });

  pi.on("session_start", async (_event, ctx: ExtensionContext) => {
    configCache = undefined;
    if (!ctx.hasUI) return;
    ctx.ui.addAutocompleteProvider((current) =>
      createSubagentAutocompleteProvider(current),
    );
    try {
      const config = loadConfig(true);
      ctx.ui.notify(
        `pi-as-subagent loaded ${config.size} subagent${config.size === 1 ? "" : "s"}.`,
        "info",
      );
    } catch (error) {
      ctx.ui.notify(
        `pi-as-subagent config error: ${error instanceof Error ? error.message : String(error)}`,
        "warning",
      );
    }
  });
}
