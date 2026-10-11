import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export function checkBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const provided = Buffer.from(header.slice("Bearer ".length).trim());
  const wanted = Buffer.from(expected);
  return provided.length === wanted.length && timingSafeEqual(provided, wanted);
}

/** Express middleware: runs before any body parsing, so unauthenticated callers get 401 first. */
export function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!checkBearerToken(req.header("authorization"), token)) {
      res.status(401).json({ error: "invalid or missing pairing token" });
      return;
    }
    next();
  };
}
