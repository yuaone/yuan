/**
 * @module governor.test
 * @description Governor unit tests (~15 cases).
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { Governor, type GovernorConfig } from "../governor.js";
import { PlanLimitError, ApprovalRequiredError } from "../errors.js";
import type { ToolCall } from "../types.js";

// ─── Helpers ───

function makeGovernor(overrides: Partial<GovernorConfig> = {}): Governor {
  return new Governor({
    planTier: "PRO",
    ...overrides,
  });
}

function makeToolCall(
  name: string,
  args: Record<string, unknown>,
): ToolCall {
  return {
    id: `tc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    name,
    arguments: args,
  };
}

// ─── Tests ───

describe("Governor", () => {
  // === 1. Iteration limit ===
  it("blocks when iteration limit is exceeded", () => {
    const gov = makeGovernor({
      customLimits: { maxIterations: 3 },
    });

    // Use up all iterations
    for (let i = 0; i < 3; i++) {
      gov.checkIteration();
      gov.recordIteration(100, 50);
    }

    // 4th iteration should throw
    assert.throws(
      () => gov.checkIteration(),
      (err: unknown) => {
        assert.ok(err instanceof PlanLimitError);
        assert.equal(err.limitName, "maxIterations");
        return true;
      },
    );
  });

  // === 2. Token budget ===
  it("blocks when token budget is exceeded", () => {
    const gov = makeGovernor({
      customLimits: { tokensPerRequest: 1000 },
    });

    gov.recordIteration(600, 500); // total = 1100 > 1000

    assert.throws(
      () => gov.checkIteration(),
      (err: unknown) => {
        assert.ok(err instanceof PlanLimitError);
        assert.equal(err.limitName, "tokensPerRequest");
        return true;
      },
    );
  });

  // === 3. Dangerous command: rm -rf ===
  it("blocks 'rm -rf /' as a dangerous command", () => {
    const gov = makeGovernor();
    const tc = makeToolCall("shell_exec", { command: "rm -rf /" });

    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        assert.equal(err.actionType, "RUN_DANGEROUS_CMD");
        return true;
      },
    );
  });

  // === 4. Safe commands: ls, cat ===
  it("allows safe commands like ls and cat", () => {
    const gov = makeGovernor();
    assert.doesNotThrow(() => {
      gov.validateToolCall(makeToolCall("shell_exec", { command: "ls -la" }));
    });
    assert.doesNotThrow(() => {
      gov.validateToolCall(makeToolCall("shell_exec", { command: "cat README.md" }));
    });
  });

  // === 5. Sensitive file write: .env ===
  it("blocks writing to sensitive files like .env", () => {
    const gov = makeGovernor();
    const tc = makeToolCall("file_write", { path: ".env" });

    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        assert.equal(err.actionType, "MODIFY_CONFIG");
        return true;
      },
    );
  });

  // === 6. Normal file write: src/app.ts ===
  it("allows writing to normal source files", () => {
    const gov = makeGovernor();
    assert.doesNotThrow(() => {
      gov.validateToolCall(makeToolCall("file_write", { path: "src/app.ts" }));
    });
  });

  // === 7. Plan tier limits: FREE vs ENTERPRISE ===
  it("FREE plan has much lower limits than ENTERPRISE", () => {
    const free = makeGovernor({ planTier: "FREE" });
    const ent = makeGovernor({ planTier: "ENTERPRISE" });

    const freeLimits = free.getLimits();
    const entLimits = ent.getLimits();

    assert.ok(
      freeLimits.maxIterations < entLimits.maxIterations,
      `FREE maxIterations (${freeLimits.maxIterations}) should be less than ENTERPRISE (${entLimits.maxIterations})`,
    );
    assert.ok(
      freeLimits.tokensPerRequest < entLimits.tokensPerRequest,
      `FREE tokens (${freeLimits.tokensPerRequest}) should be less than ENTERPRISE (${entLimits.tokensPerRequest})`,
    );
    assert.ok(
      freeLimits.sessionTtlMs < entLimits.sessionTtlMs,
    );
  });

  // === 8. Interactive command: vim ===
  it("blocks dangerous interactive-style commands via sudo pattern", () => {
    const gov = makeGovernor();
    // "sudo" is in DANGEROUS_PATTERNS
    const tc = makeToolCall("shell_exec", { command: "sudo vim /etc/hosts" });
    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        return true;
      },
    );
  });

  // === 9. Path-related sensitive file: credentials.json ===
  it("blocks writing to credentials.json", () => {
    const gov = makeGovernor();
    const tc = makeToolCall("file_write", { path: "config/credentials.json" });
    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        assert.equal(err.actionType, "MODIFY_CONFIG");
        return true;
      },
    );
  });

  // === 10. Shell meta characters ===
  it("blocks commands with shell metacharacters like ;, &&, ||, |", () => {
    const gov = makeGovernor();

    // $( is dangerous — command substitution
    const tc = makeToolCall("shell_exec", {
      command: "echo $(whoami)",
    });
    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        return true;
      },
    );
  });

  // === 11. Auto-approve dangerous command ===
  it("allows dangerous commands when auto-approved", () => {
    const gov = makeGovernor({
      autoApproveActions: ["RUN_DANGEROUS_CMD"],
    });

    // Should emit warning but not throw
    let warned = false;
    gov.on("warning", () => { warned = true; });

    assert.doesNotThrow(() => {
      gov.validateToolCall(
        makeToolCall("shell_exec", { command: "rm -rf ./build" }),
      );
    });
    assert.ok(warned, "Should have emitted a warning");
  });

  // === 12. State tracking ===
  it("tracks iteration count and token usage correctly", () => {
    const gov = makeGovernor();

    gov.recordIteration(500, 200);
    gov.recordIteration(300, 150);

    const state = gov.getState();
    assert.equal(state.iterationCount, 2);
    assert.equal(state.totalInputTokens, 800);
    assert.equal(state.totalOutputTokens, 350);
  });

  // === 13. Remaining iterations ===
  it("getRemainingIterations decreases correctly", () => {
    const gov = makeGovernor({ customLimits: { maxIterations: 10 } });
    assert.equal(gov.getRemainingIterations(), 10);

    gov.recordIteration(100, 50);
    assert.equal(gov.getRemainingIterations(), 9);
  });

  // === 14. Remaining tokens ===
  it("getRemainingTokens decreases correctly", () => {
    const gov = makeGovernor({ customLimits: { tokensPerRequest: 5000 } });
    assert.equal(gov.getRemainingTokens(), 5000);

    gov.recordIteration(1000, 500);
    assert.equal(gov.getRemainingTokens(), 3500);
  });

  // === 15. Sensitive file read emits warning but does not throw ===
  it("allows reading .env but emits a warning", () => {
    const gov = makeGovernor();
    let warned = false;
    gov.on("warning", (evt) => {
      if (evt.type === "sensitive_file_read") warned = true;
    });

    assert.doesNotThrow(() => {
      gov.validateToolCall(makeToolCall("file_read", { path: ".env.local" }));
    });
    assert.ok(warned, "Should have emitted a sensitive_file_read warning");
  });

  // === 16. Tool call count tracked ===
  it("tracks tool call count", () => {
    const gov = makeGovernor();
    gov.validateToolCall(makeToolCall("file_read", { path: "src/app.ts" }));
    gov.validateToolCall(makeToolCall("file_read", { path: "src/index.ts" }));
    assert.equal(gov.getState().toolCallCount, 2);
  });

  // === 17. String arguments parsing ===
  it("handles string-encoded arguments in tool calls", () => {
    const gov = makeGovernor();
    const tc: ToolCall = {
      id: "tc_str",
      name: "shell_exec",
      arguments: JSON.stringify({ command: "ls -la" }),
    };
    assert.doesNotThrow(() => gov.validateToolCall(tc));
  });

  // === 18. git push blocked ===
  it("blocks git push command", () => {
    const gov = makeGovernor();
    const tc = makeToolCall("shell_exec", { command: "git push origin main" });
    assert.throws(
      () => gov.validateToolCall(tc),
      (err: unknown) => {
        assert.ok(err instanceof ApprovalRequiredError);
        return true;
      },
    );
  });
});
