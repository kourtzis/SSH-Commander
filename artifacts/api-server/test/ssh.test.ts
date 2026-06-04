import { describe, it, expect } from "vitest";
import {
  applyTagSubstitution,
  appendWireLog,
  stripAnsi,
  stripAnsiStream,
  makeStripState,
} from "../src/lib/ssh.js";

describe("applyTagSubstitution", () => {
  it("substitutes {{TAG}} placeholders, tolerating inner whitespace", () => {
    const out = applyTagSubstitution("ip address={{ IP }} name={{NAME}}", {
      IP: "10.0.0.1",
      NAME: "core-rtr",
    });
    expect(out).toBe("ip address=10.0.0.1 name=core-rtr");
  });

  it("strips control bytes and carriage returns from substituted values", () => {
    // A value carrying NUL/BEL/CR must not inject those bytes onto the wire.
    const out = applyTagSubstitution("x={{V}}", { V: "a\x00b\x07c\rd" });
    expect(out).toBe("x=abcd");
  });

  it("preserves newlines in values (multi-line banners are legitimate)", () => {
    const out = applyTagSubstitution("x={{V}}", { V: "line1\nline2" });
    expect(out).toBe("x=line1\nline2");
  });
});

describe("appendWireLog", () => {
  it("truncates a single over-long line to the char cap", () => {
    const log: string[] = [];
    const huge = "A".repeat(2000);
    const buffer = appendWireLog(log, "", ">> ", huge + "\n");
    expect(buffer).toBe(""); // line was terminated, nothing left pending
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("chars truncated]");
    // The retained prefix should be capped well under the original length.
    expect(log[0].length).toBeLessThan(2000);
  });

  it("retains a trailing partial line as the returned buffer", () => {
    const log: string[] = [];
    const buffer = appendWireLog(log, "", "", "complete\npartial");
    expect(buffer).toBe("partial");
    // Each entry is wrapped with a timestamp prefix, so match on substring.
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("complete");
  });
});

describe("stripAnsi", () => {
  it("removes CSI color sequences but keeps the visible text", () => {
    expect(stripAnsi("\x1b[31mred\x1b[0m text")).toBe("red text");
  });
});

describe("stripAnsiStream", () => {
  it("reassembles an escape sequence split across two chunks", () => {
    const state = makeStripState();
    // ESC arrives at the tail of chunk A, the rest in chunk B.
    const a = stripAnsiStream(state, "before\x1b");
    const b = stripAnsiStream(state, "[31mafter");
    expect((a + b).replace(/\x1b/g, "")).toBe("beforeafter");
  });

  it("flushes rather than buffering unboundedly past the pending cap", () => {
    const state = makeStripState();
    // A lone ESC followed by a long run of non-terminating bytes would grow
    // pending without bound; the stripper must flush instead of pinning it.
    const out = stripAnsiStream(state, "\x1b" + "[".repeat(100));
    expect(state.pending.length).toBeLessThanOrEqual(64);
    expect(typeof out).toBe("string");
  });
});
