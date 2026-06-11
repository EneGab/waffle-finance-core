import pino, { type Logger } from "pino";

let cached: Logger | null = null;

export function getLogger(level: string = "info"): Logger {
  if (!cached) {
    cached = pino({ level, base: { service: "wafflefinance-coordinator" } });
  }
  return cached;
}
