/**
 * @module context-manager.test
 * @description ContextManager unit tests (~10+ cases).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { ContextManager, type ContextManagerConfig } from "../context-manager.js";
import { ContextOverflowError } from "../errors.js";
import type { Message } from "../types.js";

// ─── Helpers ───

function makeManager(
  overrides: Partial<ContextManagerConfig> = {},
): ContextManager {
  return new ContextManager({
    maxContextTokens: 100_000,
    outputReserveTokens: 4096,
    ...overrides,
  });
}

function makeMessage(
  role: Message["role"],
  content: string,
  tool_calls?: Message["tool_calls"],
): Message {
  return { role, content, tool_calls };
}

function makeSystemMessage(content: string): Message {
  return makeMessage("system", content);
}

function makeUserMessage(content: string): Message {
  return makeMessage("user", content);
}

function makeAssistantMessage(content: string): Message {
  return makeMessage("assistant", content);
}

function makeToolMessage(content: string, toolCallId = "tc_1"): Message {
  return { role: "tool", content, tool_call_id: toolCallId };
}

// ─── Tests ───

describe("ContextManager", () => {
  // === 1. Empty context ===
  it("returns empty array when no messages added", () => {
    const cm = makeManager();
    assert.equal(cm.getMessages().length, 0);
    assert.equal(cm.messageCount, 0);
  });

  // === 2. Under limit — all messages kept ===
  it("keeps all messages when under token limit", () => {
    const cm = makeManager();
    cm.addMessage(makeSystemMessage("You are a helpful assistant."));
    cm.addMessage(makeUserMessage("Hello"));
    cm.addMessage(makeAssistantMessage("Hi there!"));

    const prepared = cm.prepareForLLM();
    assert.equal(prepared.length, 3);
    assert.equal(prepared[0].role, "system");
    assert.equal(prepared[1].role, "user");
    assert.equal(prepared[2].role, "assistant");
  });

  // === 3. Over limit — old messages evicted ===
  it("compacts history when over token limit", () => {
    // Limit large enough for compacted output but smaller than full history
    const cm = makeManager({
      maxContextTokens: 500,
      outputReserveTokens: 50,
      compaction: { recentWindow: 2, summaryWindow: 2 },
    });

    cm.addMessage(makeSystemMessage("System prompt."));

    // Add many messages to exceed budget
    for (let i = 0; i < 20; i++) {
      cm.addMessage(makeUserMessage(`User message ${i}: ${"x".repeat(20)}`));
      cm.addMessage(makeAssistantMessage(`Response ${i}: ${"y".repeat(20)}`));
    }

    const prepared = cm.prepareForLLM();
    // After compaction, should have fewer messages
    assert.ok(
      prepared.length < 41,
      `Expected compacted messages (${prepared.length}) < original (41)`,
    );
    // System prompt should always be preserved
    assert.ok(
      prepared.some((m) => m.role === "system"),
      "System message should be preserved",
    );
  });

  // === 4. Tool result compression ===
  it("compresses tool results that exceed size limit", () => {
    const cm = makeManager();
    const longResult = "x".repeat(200_000);
    const compressed = cm.compressToolResult("file_read", longResult);

    // file_read limit is 50_000 (from constants)
    assert.ok(
      compressed.length < longResult.length,
      "Compressed result should be shorter",
    );
    assert.ok(
      compressed.includes("truncated"),
      "Should contain truncation marker",
    );
  });

  it("does not compress tool results within limit", () => {
    const cm = makeManager();
    const shortResult = "Hello, world!";
    const compressed = cm.compressToolResult("file_read", shortResult);
    assert.equal(compressed, shortResult);
  });

  // === 5. System prompt always kept ===
  it("preserves system messages during compaction", () => {
    const cm = makeManager({
      maxContextTokens: 300,
      outputReserveTokens: 50,
      compaction: { recentWindow: 2, summaryWindow: 2 },
    });

    cm.addMessage(makeSystemMessage("Important system instructions."));

    for (let i = 0; i < 30; i++) {
      cm.addMessage(makeUserMessage(`msg ${i} ${"a".repeat(30)}`));
      cm.addMessage(makeAssistantMessage(`reply ${i} ${"b".repeat(30)}`));
    }

    const prepared = cm.prepareForLLM();
    const systemMsgs = prepared.filter((m) => m.role === "system");
    assert.ok(
      systemMsgs.length >= 1,
      "At least one system message should be preserved",
    );
  });

  // === 6. Token estimation ===
  it("estimates token count for messages", () => {
    const cm = makeManager();
    const messages: Message[] = [
      makeSystemMessage("You are a helpful assistant."),
      makeUserMessage("Hello, how are you?"),
    ];
    const tokens = cm.estimateTokens(messages);
    assert.ok(tokens > 0, "Token count should be positive");
    // Rough check: ~30 chars of English / 4 + overhead
    assert.ok(tokens > 10, "Should estimate at least 10 tokens");
    assert.ok(tokens < 200, "Should not overestimate wildly");
  });

  it("estimates higher token count for CJK text", () => {
    const cm = makeManager();
    const engMessages: Message[] = [makeUserMessage("a".repeat(100))];
    const cjkMessages: Message[] = [makeUserMessage("가".repeat(100))];

    const engTokens = cm.estimateTokens(engMessages);
    const cjkTokens = cm.estimateTokens(cjkMessages);

    // CJK should produce more tokens per character (2 chars/token vs 4)
    assert.ok(
      cjkTokens > engTokens,
      `CJK tokens (${cjkTokens}) should be > English tokens (${engTokens})`,
    );
  });

  // === 7. prepareForLLM returns valid Message[] ===
  it("prepareForLLM returns array of Messages with correct roles", () => {
    const cm = makeManager();
    cm.addMessage(makeSystemMessage("System"));
    cm.addMessage(makeUserMessage("User"));
    cm.addMessage(makeAssistantMessage("Assistant"));

    const result = cm.prepareForLLM();
    assert.ok(Array.isArray(result));
    for (const msg of result) {
      assert.ok(
        ["system", "user", "assistant", "tool"].includes(msg.role),
        `Invalid role: ${msg.role}`,
      );
    }
  });

  // === 8. Clear resets history ===
  it("clear removes all messages", () => {
    const cm = makeManager();
    cm.addMessage(makeUserMessage("test"));
    assert.equal(cm.messageCount, 1);

    cm.clear();
    assert.equal(cm.messageCount, 0);
    assert.equal(cm.getMessages().length, 0);
  });

  // === 9. addMessages batch ===
  it("addMessages adds multiple messages at once", () => {
    const cm = makeManager();
    cm.addMessages([
      makeUserMessage("one"),
      makeAssistantMessage("two"),
      makeUserMessage("three"),
    ]);
    assert.equal(cm.messageCount, 3);
  });

  // === 10. getCurrentTokenCount tracks total ===
  it("getCurrentTokenCount updates as messages are added", () => {
    const cm = makeManager();
    const initial = cm.getCurrentTokenCount();
    assert.equal(initial, 0);

    cm.addMessage(makeUserMessage("Hello world this is a test message"));
    const afterOne = cm.getCurrentTokenCount();
    assert.ok(afterOne > 0);

    cm.addMessage(makeAssistantMessage("This is a response with some content"));
    const afterTwo = cm.getCurrentTokenCount();
    assert.ok(afterTwo > afterOne);
  });

  // === 11. getMessages returns a copy ===
  it("getMessages returns a copy, not the internal array", () => {
    const cm = makeManager();
    cm.addMessage(makeUserMessage("test"));
    const msgs = cm.getMessages();
    msgs.push(makeUserMessage("injected"));
    assert.equal(cm.messageCount, 1, "Internal array should not be modified");
  });

  // === 12. Tool calls in token estimation ===
  it("includes tool_calls in token estimation", () => {
    const cm = makeManager();
    const withoutTools: Message[] = [makeAssistantMessage("reply")];
    const withTools: Message[] = [
      makeMessage("assistant", "reply", [
        {
          id: "tc_1",
          name: "file_read",
          arguments: JSON.stringify({ path: "src/app.ts" }),
        },
      ]),
    ];

    const tokensWithout = cm.estimateTokens(withoutTools);
    const tokensWith = cm.estimateTokens(withTools);

    assert.ok(
      tokensWith > tokensWithout,
      "Messages with tool calls should have higher token count",
    );
  });

  // === 13. ContextOverflowError when compaction is insufficient ===
  it("throws ContextOverflowError when even compaction cannot fit", () => {
    // Extremely small limit
    const cm = makeManager({
      maxContextTokens: 20,
      outputReserveTokens: 10,
      compaction: { recentWindow: 1, summaryWindow: 0 },
    });

    // Add a system message and a very long user message
    cm.addMessage(makeSystemMessage("System prompt that is fairly long to exceed the tiny limit we set."));
    cm.addMessage(makeUserMessage("x".repeat(500)));

    assert.throws(
      () => cm.prepareForLLM(),
      (err: unknown) => {
        assert.ok(err instanceof ContextOverflowError);
        assert.ok(err.currentTokens > 0);
        assert.ok(err.maxTokens > 0);
        return true;
      },
    );
  });

  // === 14. Compression preserves head and tail ===
  it("compression keeps head and tail of long tool results", () => {
    const cm = makeManager();
    const longResult = "HEAD" + "x".repeat(200_000) + "TAIL";
    const compressed = cm.compressToolResult("file_read", longResult);

    assert.ok(compressed.startsWith("HEAD"), "Should preserve head");
    assert.ok(compressed.endsWith("TAIL"), "Should preserve tail");
  });
});
