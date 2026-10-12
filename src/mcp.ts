import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RETENTION_DAYS, type HealthStore } from "./store.js";
import { SAMPLE_TYPES } from "./types.js";

const HEALTH_DATA_CONSUMPTION_INSTRUCTIONS = `Health data consumption and presentation (Local and Cloud):
- Time/timezone: sleepStart, sleepEnd, start and end may be ISO 8601 UTC timestamps ending in Z. Preserve raw timestamps for storage and calculations. When presenting clock times, convert UTC to the user's local timezone when that timezone is known. Do not display UTC clock times as though they were local. Do not assume the Agent host timezone: a VPS or server may use a different timezone. If the user's timezone is unknown, explicitly label UTC times as UTC or ask for their timezone.
- Sleep date: date is already the wake-up calendar date calculated by Mibly using the iPhone's local calendar. Treat date as authoritative for the sleep record. Do not recompute or change date from sleepStart/sleepEnd UTC timestamps.
- Sleep minutes: durations and stage values may contain fractional minutes. Preserve raw fractional values for calculations. When presenting whole minutes, round to the nearest minute; do not truncate (for example, 59.6 minutes displays as 60 minutes).
- Missing sleep stages: null means stage data is unavailable. Never interpret null as 0. Never invent or infer a missing sleep stage.
- Body Fat: bodyFat.value is already a human percentage: 23.5 means 23.5%. Do not divide by 100 or multiply by 100 when presenting it.
- Heart rate: a heartRate sample is an hourly summary, not a single reading. value is that hour's average bpm; heartRateSummary has min, avg, max, count and context. context is sedentary (still), active (moving) or unknown (Apple Health did not label it); the same hour can appear once per context. The newest hour may still be in progress and is replaced when updated. Older samples may be single readings without heartRateSummary.
- Resting heart rate: restingHeartRate and walkingHeartRateAverage are separate daily values from Apple Health (one per day, bpm). Use restingHeartRate for the user's resting heart rate; never derive it from heartRate minimums or sedentary averages, and do not compare active hours with sedentary hours as if they were the same kind of reading.
These are consumption/presentation rules only; preserve the raw Health data and existing calculations.`;

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });

export function createMcpServer(store: HealthStore): McpServer {
  const server = new McpServer({ name: "mibly", version: "0.1.0" });

  server.registerTool(
    "health_now",
    {
      title: "Latest Apple Health snapshot",
      description:
        "Compact snapshot of the user's most recent sleep, steps, heart rate (latest hourly summary), resting heart rate, walking heart rate average, HRV, workout, weight, body fat, and (if the user opted in separately) menstrual flow samples pushed from their iPhone. Use this for quick, high-frequency status checks. Sleep adds date (wake-up date), totalSleepMinutes, deepMinutes, coreMinutes, remMinutes, awakeMinutes, sleepStart and sleepEnd when available; missing stages are null, and legacy sleep may contain only value/min. Body fat is bodyFat with value as a percentage (23.5 means 23.5%) and unit %." +
        "\n\n" + HEALTH_DATA_CONSUMPTION_INSTRUCTIONS,
      inputSchema: {},
    },
    async () => {
      store.recordQuery("health_now");
      return text(store.now());
    }
  );

  server.registerTool(
    "health_detail",
    {
      title: "Apple Health detail query",
      description:
        `Detailed time-range query for one health data type. Limited to the last ${RETENTION_DAYS} days.` +
        "\n\n" + HEALTH_DATA_CONSUMPTION_INSTRUCTIONS,
      inputSchema: {
        type: z.enum(SAMPLE_TYPES).describe("Which health data type to query. Sleep summaries use wake-up dates and nullable stage minutes; bodyFat values are percentages, not fractions."),
        start: z.string().describe("ISO 8601 start of the range."),
        end: z.string().describe("ISO 8601 end of the range."),
      },
    },
    async ({ type, start, end }) => {
      store.recordQuery(`health_detail:${type}`);
      return text(store.detail(type, start, end));
    }
  );

  return server;
}
