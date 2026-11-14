import { expect, test } from "bun:test";
import * as typebox from "@oh-my-pi/omptype/typebox";
import { normalizeTools } from "@oh-my-pi/pi-agent-core";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { RegisteredToolAdapter, ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import sessionBus from "../src/index";

// Removing session_inbox's strict opt-out must fail this boundary test: optional
// identifiers must be omitted, never converted into required nullable arguments.
// Real registration, host wrappers, normalization and Responses conversion run;
// only lifecycle/UI methods are absent because no session is started here.
test("registered inbox preserves omitted IDs and offsets in Responses tool schemas", () => {
  const tools = new Map<string, ToolDefinition>();
  const api = {
    typebox,
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI;
  sessionBus(api);
  const definition = tools.get("session_inbox");
  expect(definition).toBeDefined();
  if (!definition) throw new Error("Inbox tool was not registered");
  // Description lookup is the only runner operation used by the real wrappers.
  const runner = { getNativeDelegationGuidance: () => undefined } as unknown as ExtensionRunner;
  const sourceInfo = { path: "src/index.ts", source: "extension", scope: "temporary", origin: "top-level" } as const;
  const adapter = new RegisteredToolAdapter({ definition, extensionPath: "src/index.ts", sourceInfo }, runner);
  const wrapped = new ExtensionToolWrapper(adapter, runner);
  const model = buildModel({
    id: "gpt-5", name: "Offline schema contract", api: "openai-responses", provider: "openai",
    baseUrl: "https://api.openai.com/v1", reasoning: true, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096,
  });
  const schema = definition.parameters;
  const original = JSON.stringify(typeof schema.toJsonSchema === "function" ? schema.toJsonSchema() : schema);
  for (const injectIntent of [false, true]) {
    for (const pruneDescriptions of [false, true]) {
      const normalized = normalizeTools([wrapped], { injectIntent, pruneDescriptions });
      const emitted = convertTools(normalized ?? [], true, model);
      expect(emitted).toHaveLength(1);
      const tool = emitted[0];
      if (tool?.type !== "function") throw new Error("Inbox must remain a function tool");
      expect(tool.strict).toBe(false);
      expect(tool.parameters).toMatchObject({
        required: injectIntent ? ["action", "i"] : ["action"],
        properties: {
          batchId: { type: "string" },
          offset: { type: "integer", minimum: 0 },
        },
      });
      expect(JSON.stringify(typeof schema.toJsonSchema === "function" ? schema.toJsonSchema() : schema)).toBe(original);
    }
  }
});
