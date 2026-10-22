export function evaluationDate(value?: string | null) {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
    day: "numeric",
    month: "short",
    year: "numeric",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value;
  return `${part("hour")}:${part("minute")} ${part("dayPeriod")} ${part("day")} ${part("month")}. ${part("year")}.`;
}
