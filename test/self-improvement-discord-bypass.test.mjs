import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jitiFactory from "jiti";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginSdkStubPath = path.resolve(testDir, "helpers", "openclaw-plugin-sdk-stub.mjs");
const jiti = jitiFactory(import.meta.url, {
  interopDefault: true,
  alias: {
    "openclaw/plugin-sdk": pluginSdkStubPath,
  },
});

const pluginModule = jiti("../index.ts");
const memoryLanceDBProPlugin = pluginModule.default || pluginModule;

function createPluginApiHarness({ pluginConfig, resolveRoot }) {
  const eventHandlers = new Map();
  const logs = [];

  const api = {
    pluginConfig,
    resolvePath(target) {
      if (typeof target !== "string") return target;
      if (path.isAbsolute(target)) return target;
      return path.join(resolveRoot, target);
    },
    logger: {
      info(message) { logs.push(["info", String(message)]); },
      warn(message) { logs.push(["warn", String(message)]); },
      debug(message) { logs.push(["debug", String(message)]); },
      error(message) { logs.push(["error", String(message)]); },
    },
    registerTool() {},
    registerCli() {},
    registerService() {},
    on() {},
    registerHook(eventName, handler, opts) {
      const list = eventHandlers.get(eventName) || [];
      list.push({ handler, meta: opts });
      eventHandlers.set(eventName, list);
    },
  };

  return { api, eventHandlers, logs };
}

function makePluginConfig(workDir) {
  return {
    dbPath: path.join(workDir, "db"),
    embedding: { apiKey: "test-api-key", dimensions: 4 },
    sessionStrategy: "memoryReflection",
    smartExtraction: false,
    autoCapture: false,
    autoRecall: false,
    selfImprovement: { enabled: true, beforeResetNote: true, ensureLearningFiles: false },
  };
}

function buildHookEvent({ provider, threadId, sessionKey = "agent:main:discord:test" }) {
  return {
    action: "new",
    sessionKey,
    messages: [],
    context: {
      commandSource: "slash",
      sessionEntry: {
        Provider: provider,
        threadId: threadId,
      },
    },
  };
}

describe("self-improvement appendSelfImprovementNote Discord bypass", () => {
  let workDir;
  let harness;
  let hookHandler;

  beforeEach(() => {
    workDir = mkdtempSync(path.join(tmpdir(), "discord-bypass-"));
    const pluginConfig = makePluginConfig(workDir);
    harness = createPluginApiHarness({ resolveRoot: workDir, pluginConfig });
    memoryLanceDBProPlugin.register(harness.api);

    const hooks = harness.eventHandlers.get("command:new") || [];
    const selfImprovementHooks = hooks.filter(h => (h.meta?.name || "").includes("self-improvement"));
    assert.equal(selfImprovementHooks.length, 1, "expected exactly one command:new self-improvement hook");
    hookHandler = selfImprovementHooks[0].handler;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("skips note inject on Discord channel (non-thread) reset to avoid startup race", async () => {
    // Discord channel /new has Provider=discord but NO threadId
    const event = buildHookEvent({ provider: "discord", threadId: null });

    await hookHandler(event);

    // messages should remain empty — hook returned early
    assert.deepStrictEqual(event.messages, [], "Discord channel reset should not inject note");
    // Should have logged the skip
    const skipLog = harness.logs.find(([level, msg]) => level === "info" && msg.includes("skipped on Discord channel"));
    assert.ok(skipLog, "Expected skip log not found: " + JSON.stringify(harness.logs));
  });

  it("skips note inject on Discord channel when threadId is empty string", async () => {
    const event = buildHookEvent({ provider: "discord", threadId: "" });

    await hookHandler(event);

    assert.deepStrictEqual(event.messages, [], "Discord channel reset (empty threadId) should not inject note");
    const skipLog = harness.logs.find(([level, msg]) => level === "info" && msg.includes("skipped on Discord channel"));
    assert.ok(skipLog, "Expected skip log not found: " + JSON.stringify(harness.logs));
  });

  it("proceeds with note inject on Discord thread /new", async () => {
    // Discord thread /new has Provider=discord AND a threadId
    const event = buildHookEvent({ provider: "discord", threadId: "1234567890" });

    await hookHandler(event);

    // Note should have been injected
    assert.ok(event.messages.length > 0, "Discord thread should inject note");
    assert.ok(
      event.messages.some((m) => typeof m === "string" && m.includes("If anything was learned")),
      "Injected note should contain self-improvement prompt"
    );
  });

  it("proceeds with note inject on non-Discord surfaces (telegram)", async () => {
    const event = buildHookEvent({ provider: "telegram", threadId: undefined });

    await hookHandler(event);

    assert.ok(event.messages.length > 0, "Telegram should inject note");
    assert.ok(
      event.messages.some((m) => typeof m === "string" && m.includes("If anything was learned")),
      "Injected note should contain self-improvement prompt"
    );
  });

  it("proceeds with note inject on non-Discord surfaces (whatsapp)", async () => {
    const event = buildHookEvent({ provider: "whatsapp", threadId: "thread-abc" });

    await hookHandler(event);

    assert.ok(event.messages.length > 0, "WhatsApp should inject note");
    assert.ok(
      event.messages.some((m) => typeof m === "string" && m.includes("If anything was learned")),
      "Injected note should contain self-improvement prompt"
    );
  });

  it("skips duplicate inject if note already present", async () => {
    const existingNote = "/note self-improvement (before reset):\n" +
      "- If anything was learned/corrected, log it now:";
    const event = buildHookEvent({ provider: "discord", threadId: "1234567890" });
    event.messages.push(existingNote);

    await hookHandler(event);

    // Only the original note should remain
    assert.equal(event.messages.filter((m) => typeof m === "string" && m.includes("/note self-improvement")).length, 1);
    const duplicateLog = harness.logs.find(([level, msg]) => level === "info" && msg.includes("note already present"));
    assert.ok(duplicateLog, "Expected duplicate skip log not found");
  });
});
