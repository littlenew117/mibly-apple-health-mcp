export const SAMPLE_TYPES = [
  "sleep",
  "steps",
  "heartRate",
  "restingHeartRate",
  "walkingHeartRateAverage",
  "hrv",
  "workout",
  "weight",
  "bodyFat",
  "menstrualFlow",
] as const;

export type HealthSampleType = (typeof SAMPLE_TYPES)[number];

export const HEART_RATE_CONTEXTS = ["sedentary", "active", "unknown"] as const;

/** Hourly heart rate summary carried by a `heartRate` sample (`value` = avg). */
export interface HeartRateSummary {
  min: number;
  avg: number;
  max: number;
  count: number;
  context: (typeof HEART_RATE_CONTEXTS)[number];
}

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
  /** Stable identity chosen by the phone. When present it is the dedupe key. */
  sampleId?: string;
  heartRateSummary?: HeartRateSummary;
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
