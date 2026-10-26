import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Bearer-secret check for everything Sarvam calls.
 *
 * In production a missing secret is a hard failure. Silently running an open
 * endpoint that writes commitments is worse than being down.
 */
export function requireToolSecret(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const expected = process.env.SARVAM_TOOL_SECRET ?? "";
    const isProduction = process.env.NODE_ENV === "production";

    if (!expected) {
      if (isProduction) {
        res.status(503).json({ error: "SARVAM_TOOL_SECRET is not configured" });
        return;
      }
      next();
      return;
    }

    const header = req.get("authorization") ?? "";
    const token = header.toLowerCase().startsWith("bearer ")
      ? header.slice(7).trim()
      : (req.get("x-api-key") ?? "");

    if (!safeEqual(token, expected)) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }

    next();
  };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
