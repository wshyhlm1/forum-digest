import { DEFAULT_TIMEZONE, SCHEDULED_SLOTS } from "./constants.js";
import type { RunMode, RunSlot, ScheduledSlot } from "./types.js";

function getChinaParts(date: Date): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
}

function mapParts(parts: Intl.DateTimeFormatPart[]): Record<string, string> {
  return parts.reduce<Record<string, string>>((accumulator, part) => {
    if (part.type !== "literal") {
      accumulator[part.type] = part.value;
    }
    return accumulator;
  }, {});
}

export function formatBatchId(date: Date): string {
  return formatChinaDate(date);
}

export function formatChinaDate(date: Date): string {
  const parts = mapParts(getChinaParts(date));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatChinaDisplay(date: Date): string {
  const parts = mapParts(getChinaParts(date));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

export function resolveSlot(mode: RunMode, providedSlot?: RunSlot, now: Date = new Date()): RunSlot {
  if (mode === "manual") {
    return "manual";
  }

  if (providedSlot && providedSlot !== "manual") {
    return providedSlot;
  }

  const hourMinute = formatChinaDisplay(now).slice(-5) as ScheduledSlot;
  const matched = SCHEDULED_SLOTS.find((slot) => slot === hourMinute);
  return matched ?? "00:00";
}

function shiftDateOnly(dateOnly: string, days: number): string {
  const [year, month, day] = dateOnly.split("-").map((part) => Number.parseInt(part, 10));
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return shifted.toISOString().slice(0, 10);
}

export function resolveTargetDate(mode: RunMode, now: Date = new Date(), providedTargetDate?: string): string {
  if (providedTargetDate && /^\d{4}-\d{2}-\d{2}$/.test(providedTargetDate)) {
    return providedTargetDate;
  }

  const dateOnly = formatChinaDate(now);
  const parts = mapParts(getChinaParts(now));
  const hour = Number.parseInt(parts.hour ?? "0", 10);
  const minute = Number.parseInt(parts.minute ?? "0", 10);
  if (mode === "scheduled" && hour === 0 && minute <= 30) {
    return shiftDateOnly(dateOnly, -1);
  }
  return dateOnly;
}

export function getChinaDayRangeIso(targetDate: string): { startIso: string; endIso: string; startUnix: number; endUnix: number } {
  const [year, month, day] = targetDate.split("-").map((part) => Number.parseInt(part, 10));
  const startMs = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
  const endMs = startMs + 24 * 60 * 60 * 1000;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    startUnix: Math.floor(startMs / 1000),
    endUnix: Math.floor(endMs / 1000)
  };
}
