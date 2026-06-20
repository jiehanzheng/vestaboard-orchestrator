export const NAMED_PRIORITY_VALUES = {
  none: 0,
  low: 10,
  normal: 50,
  high: 80,
  urgent: 100
} as const;

export type PriorityName = keyof typeof NAMED_PRIORITY_VALUES;
export type Priority = PriorityName | number | (string & {});

export function priorityValue(priority: Priority): number {
  if (typeof priority === "number" && Number.isFinite(priority)) {
    return priority;
  }

  const normalized = String(priority).trim().toLowerCase();
  const namedPriority = NAMED_PRIORITY_VALUES[normalized as PriorityName];
  if (namedPriority !== undefined) {
    return namedPriority;
  }

  const numericPriority = Number(normalized);
  return Number.isFinite(numericPriority) ? numericPriority : 0;
}
