export const SAMPLE_TYPES = [
  "sleep",
  "steps",
  "heartRate",
  "hrv",
  "workout",
  "weight",
  "bodyFat",
  "menstrualFlow",
] as const;

export type HealthSampleType = (typeof SAMPLE_TYPES)[number];

/**
 * One reading as pushed by the iPhone. Only the fields below are validated;
 * everything else (the Sleep summary fields `date`, `totalSleepMinutes`,
 * `deepMinutes`, ..., `sleepEnd`, which may be null) is stored and returned
 * untouched.
 */
export interface HealthSample {
  type: HealthSampleType;
  start: string; // ISO 8601
  end: string; // ISO 8601
  value: number;
  unit: string;
  source?: string;
  [extra: string]: unknown;
}

export interface IngestPayload {
  samples: HealthSample[];
  deviceName?: string;
}

/** The plaintext that gets encrypted into ~/.mibly/data.enc. */
export interface StoreSnapshot {
  latest: Partial<Record<HealthSampleType, HealthSample>>;
  history: HealthSample[];
  lastPushAt: string | null;
}
