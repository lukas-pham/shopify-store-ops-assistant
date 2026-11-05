import { describe, expect, it } from "vitest";
import { containsPII, redactPII } from "../app/lib/pii";
import { checkGrounding, numbersInText } from "../app/lib/grounding";
import { parsePeriod } from "../app/lib/dates";

describe("redactPII", () => {
  it("removes emails, phone numbers and street addresses", () => {
    const out = redactPII("Call me on +84 912 345 678 or mail an.nguyen@example.com, ship to 12 Nguyen Trai Street");
    expect(out).not.toMatch(/example\.com|912|Nguyen Trai Street/);
    expect(out).toContain("[email]");
    expect(out).toContain("[phone]");
    expect(out).toContain("[address]");
    expect(containsPII(out)).toBe(false);
  });
  it("keeps ordinary text", () => {
    expect(redactPII("Gift wrap please")).toBe("Gift wrap please");
  });
});

describe("checkGrounding", () => {
  const steps = new Map<number, unknown>([[1, { totalSales: 1234.5, orderCount: 17, period: "2026-10-30 to 2026-11-05" }]]);
  it("accepts figures that come from tool data", () => {
    const w = checkGrounding("Sales were 1,234.50 USD from 17 orders.", [
      { label: "Sales", value: 1234.5, unit: "USD", period: "2026-10-30 to 2026-11-05", sourceStep: 1 },
      { label: "Orders", value: 17, unit: "orders", period: "2026-10-30 to 2026-11-05", sourceStep: 1 },
    ], steps);
    expect(w).toEqual([]);
  });
  it("flags invented numbers in the text", () => {
    expect(checkGrounding("Sales grew 23.4% to 1,234.50 USD.", [], steps).some((w) => w.includes("23.4"))).toBe(true);
  });
  it("flags figures citing the wrong step or without a period", () => {
    const w = checkGrounding("", [{ label: "Sales", value: 999, unit: "USD", period: "", sourceStep: 1 }], steps);
    expect(w.length).toBe(2);
  });
  it("ignores years and small counts", () => {
    expect(numbersInText("Top 5 products in 2026")).toEqual([]);
  });
});

describe("parsePeriod", () => {
  it("defaults to the last 7 days", () => {
    expect(parsePeriod(undefined, undefined, new Date("2026-11-05T10:00:00Z"))).toEqual({ from: "2026-10-30", to: "2026-11-05" });
  });
  it("rejects reversed or too long ranges", () => {
    expect(() => parsePeriod("2026-11-05", "2026-11-01")).toThrow();
    expect(() => parsePeriod("2024-01-01", "2026-01-01")).toThrow();
  });
});
