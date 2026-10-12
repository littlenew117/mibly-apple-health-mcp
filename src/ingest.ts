import type { Request, Response } from "express";
import type { HealthStore } from "./store.js";
import { HEART_RATE_CONTEXTS, SAMPLE_TYPES, type HealthSample, type IngestPayload } from "./types.js";

const MALFORMED = { error: "malformed payload: expected { samples: HealthSample[] }" };

const isKnownType = (t: string) => (SAMPLE_TYPES as readonly string[]).includes(t);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isValidHeartRateSummary(v: unknown): boolean {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    isNum(h.min) &&
    isNum(h.avg) &&
    isNum(h.max) &&
    isNum(h.count) &&
    h.min <= h.avg &&
    h.avg <= h.max &&
    (HEART_RATE_CONTEXTS as readonly unknown[]).includes(h.context)
  );
}

// Deliberately shallow: required fields and their JS types only. Optional and
// extra fields (e.g. the Sleep summary) are kept exactly as the phone sent them.
// `type` is checked separately so an unknown type skips that sample instead of
// failing the whole batch (a newer app can add types without breaking this receiver).
function hasValidShape(s: unknown): s is HealthSample {
  if (typeof s !== "object" || s === null) return false;
  const x = s as Record<string, unknown>;
  return (
    typeof x.type === "string" &&
    typeof x.start === "string" &&
    typeof x.end === "string" &&
    typeof x.value === "number" &&
    typeof x.unit === "string" &&
    (x.sampleId === undefined || typeof x.sampleId === "string") &&
    (x.heartRateSummary === undefined || isValidHeartRateSummary(x.heartRateSummary))
  );
}

export function ingestHandler(store: HealthStore) {
  return (req: Request, res: Response) => {
    const body = req.body as IngestPayload | undefined;
    if (!body || !Array.isArray(body.samples) || !body.samples.every(hasValidShape)) {
      res.status(400).json(MALFORMED);
      return;
    }
    const accepted = body.samples.filter((s) => isKnownType(s.type));
    const rejectedTypes = [...new Set(body.samples.filter((s) => !isKnownType(s.type)).map((s) => s.type))];
    store.ingest(accepted);
    res.status(200).json({ ok: true, received: accepted.length, ...(rejectedTypes.length ? { rejectedTypes } : {}) });
  };
}

export { MALFORMED };
