import { OKXFacilitatorClient } from "@okxweb3/x402-core";
import { x402ResourceServer } from "@okxweb3/x402-core/server";
import { ExactEvmScheme } from "@okxweb3/x402-evm/exact/server";
import { paymentMiddleware } from "@okxweb3/x402-express";
import { addressSchema } from "@prismpulse/schemas";
import type { RequestHandler } from "express";
import { z } from "zod";

const paymentConfigSchema = z.object({
  OKX_API_KEY: z.string().min(1),
  OKX_SECRET_KEY: z.string().min(1),
  OKX_PASSPHRASE: z.string().min(1),
  OKX_BASE_URL: z.string().url().default("https://web3.okx.com"),
  PAY_TO_ADDRESS: addressSchema,
  SENTINEL_PRICE_USD: z
    .string()
    .regex(/^\$\d+(?:\.\d{1,6})?$/)
    .default("$0.01"),
});

export type PaymentGate =
  | { enabled: false }
  | { enabled: true; middleware: RequestHandler };

export function createPaymentGate(
  environment: NodeJS.ProcessEnv,
): PaymentGate {
  if (environment.PAYMENTS_ENABLED !== "true") {
    return { enabled: false };
  }

  const parsed = paymentConfigSchema.safeParse(environment);
  if (!parsed.success) {
    const fields = Object.keys(parsed.error.flatten().fieldErrors).join(", ");
    throw new Error(`Invalid payment configuration: ${fields}`);
  }

  const facilitator = new OKXFacilitatorClient({
    apiKey: parsed.data.OKX_API_KEY,
    secretKey: parsed.data.OKX_SECRET_KEY,
    passphrase: parsed.data.OKX_PASSPHRASE,
    baseUrl: parsed.data.OKX_BASE_URL,
    syncSettle: true,
  });
  const server = new x402ResourceServer(facilitator).register(
    "eip155:196",
    new ExactEvmScheme(),
  );

  const middleware = paymentMiddleware(
    {
      "POST /v1/sentinel/check": {
        accepts: {
          scheme: "exact",
          network: "eip155:196",
          payTo: parsed.data.PAY_TO_ADDRESS,
          price: parsed.data.SENTINEL_PRICE_USD,
          maxTimeoutSeconds: 300,
        },
        description: "Evidence-backed PrismPulse Sentinel transaction check. Request schema and example: https://api.getprismpulse.xyz/v1/sentinel/schema",
        mimeType: "application/json",
      },
    },
    server,
  );

  return { enabled: true, middleware };
}
