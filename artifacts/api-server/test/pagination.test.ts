import { describe, it, expect } from "vitest";
import type { Request } from "express";
import { parsePagination } from "../src/lib/pagination.js";

// parsePagination only reads req.query, so a minimal stub is enough.
function req(query: Record<string, unknown>): Request {
  return { query } as unknown as Request;
}

describe("parsePagination", () => {
  it("returns null when no limit is supplied (backward-compat array shape)", () => {
    expect(parsePagination(req({}))).toBeNull();
  });

  it("parses limit and offset", () => {
    expect(parsePagination(req({ limit: "25", offset: "50" }))).toEqual({ limit: 25, offset: 50 });
  });

  it("defaults offset to 0 when omitted", () => {
    expect(parsePagination(req({ limit: "10" }))).toEqual({ limit: 10, offset: 0 });
  });

  it("clamps limit to the [1, 500] range", () => {
    expect(parsePagination(req({ limit: "9999" }))?.limit).toBe(500);
    expect(parsePagination(req({ limit: "0" }))?.limit).toBe(1);
    expect(parsePagination(req({ limit: "-5" }))?.limit).toBe(1);
  });

  it("clamps a negative offset to 0", () => {
    expect(parsePagination(req({ limit: "10", offset: "-20" }))?.offset).toBe(0);
  });
});
