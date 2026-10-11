import type { Request, Response } from "express";
import type { HealthStore } from "./store.js";
import { SAMPLE_TYPES, type HealthSample, type IngestPayload } from "./types.js";

const MALFORMED = { error: "malformed payload: expected { samples: HealthSample[] }" };

// Deliberately shallow: required fields and their JS types only. Optional and
// extra fields (e.g. the Sleep summary) are kept exactly as the phone sent them.
function isValidSample(s: unknown): s is HealthSample {
  if (typeof s !== "object" || s === null) return false;
  const x = s as Record<string, unknown>;
  return (
    typeof x.type === "string" &&
    (SAMPLE_TYPES as readonly string[]).includes(x.type) &&
    typeof x.start === "string" &&
    typeof x.end === "string" &&
    typeof x.value === "number" &&
    typeof x.unit === "string"
  );
}

export function ingestHandler(store: HealthStore) {
  return (req: Request, res: Response) => {
    const body = req.body as IngestPayload | undefined;
    if (!body || !Array.isArray(body.samples) || !body.samples.every(isValidSample)) {
      res.status(400).json(MALFORMED);
      return;
    }
    store.ingest(body.samples);
    res.status(200).json({ ok: true, received: body.samples.length });
  };
}

export { MALFORMED };
