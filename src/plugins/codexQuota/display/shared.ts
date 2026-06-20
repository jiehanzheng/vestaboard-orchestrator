export const RED = 63;
export const ORANGE = 64;
export const YELLOW = 65;
export const GREEN = 66;
export const BLUE = 67;
export const VIOLET = 68;
export const WHITE = 69;
export const BLACK = 70;
export const HEART = 62;
export const BLANK = 0;

const PUNCTUATION_CODES: Record<string, number> = {
  "!": 37,
  "@": 38,
  "#": 39,
  "$": 40,
  "(": 41,
  ")": 42,
  "-": 44,
  "+": 46,
  "&": 47,
  "=": 48,
  ";": 49,
  ":": 50,
  "'": 52,
  "\"": 53,
  "%": 54,
  ",": 55,
  ".": 56,
  "/": 59,
  "?": 60,
  "°": 62,
  "♥": HEART
};

export function sanitizeDisplayText(message: string): string {
  return sanitizeText(message).replace(/\s+/g, " ").trim();
}

export function sanitizeText(message: string): string {
  return message
    .toUpperCase()
    .replace(/[^A-Z0-9 !@#$()+&=;:'"%.,/?°♥-]/g, " ");
}

export function sanitizeRowText(message: string): string {
  return sanitizeText(message);
}

export function percentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return percent >= 100 ? "100" : `${String(percent).padStart(2, " ")}%`;
}

export function flagshipPercentLabel(remainingRatio: number): string {
  const percent = Math.round(clamp(remainingRatio) * 100);
  return `${percent}%`;
}

export function hhmm(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}${parts.minute}`;
}

export function mmdd(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.month}/${parts.day}`;
}

export function hhmmWithColon(date: Date, timeZone?: string): string {
  const parts = dateParts(date, timeZone);
  return `${parts.hour}:${parts.minute}`;
}

export function encode(text: string): number[] {
  return [...text].map(charCode);
}

export function charCode(char: string): number {
  if (char === " ") return BLANK;
  const punctuationCode = PUNCTUATION_CODES[char];
  if (punctuationCode !== undefined) return punctuationCode;

  const code = char.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) return code - 64;
  if (char >= "1" && char <= "9") return Number(char) + 26;
  if (char === "0") return 36;

  throw new Error(`Unsupported Vestaboard character: ${char}`);
}

export function clamp(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function dateParts(date: Date, timeZone?: string): Record<"month" | "day" | "hour" | "minute", string> {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    month: parts.month ?? "00",
    day: parts.day ?? "00",
    hour: parts.hour === "24" ? "00" : (parts.hour ?? "00"),
    minute: parts.minute ?? "00"
  };
}
