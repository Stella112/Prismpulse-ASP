import { describe, expect, it } from "vitest";
import { createPaymentGate } from "./payments.js";

describe("createPaymentGate", () => {
  it("is disabled unless explicitly enabled", () => {
    expect(createPaymentGate({})).toEqual({ enabled: false });
  });

  it("fails closed when enabled without seller credentials", () => {
    expect(() => createPaymentGate({ PAYMENTS_ENABLED: "true" })).toThrow(
      /Invalid payment configuration/,
    );
  });
});
