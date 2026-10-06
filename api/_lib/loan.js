// Date, money and status helpers. These mirror the helpers in index.html.

export function money(cents) {
  return new Intl.NumberFormat("en-AU", {
    style: "currency", currency: "AUD", minimumFractionDigits: 2
  }).format((Number(cents) || 0) / 100);
}

export function todayKey(now = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Australia/Sydney", year: "numeric", month: "2-digit", day: "2-digit"
  });
  const obj = Object.fromEntries(formatter.formatToParts(now).map(p => [p.type, p.value]));
  return `${obj.year}-${obj.month}-${obj.day}`;
}

export function addDays(dateKey, days) {
  const d = new Date(dateKey + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(fromKey, toKey) {
  return Math.round((Date.parse(toKey + "T00:00:00Z") - Date.parse(fromKey + "T00:00:00Z")) / 86400000);
}

// "1 Oct 2026", or "1 Oct" with {year:false}.
export function formatDate(dateKey, opts = {}) {
  if (!dateKey) return "";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric", month: "short", year: opts.year === false ? undefined : "numeric", timeZone: "UTC"
  }).format(new Date(dateKey + "T00:00:00Z"));
}

export function isDirectDebit(type) {
  return type === "direct_debit" || type === "initial_direct_debit";
}

// Same rules as statusForRow in index.html, except a manual row due today is
// "due" rather than "overdue" so reminders can word it differently.
export function statusForRow(row, today = todayKey()) {
  if (row.status === "paid" || row.status === "auto_paid") return row.status;
  if (isDirectDebit(row.type)) return row.due_date <= today ? "auto_paid" : "scheduled";
  if (row.status === "skipped" || row.status === "missed") return row.status;
  if (row.due_date < today) return "overdue";
  if (row.due_date === today) return "due";
  return "scheduled";
}

export function typeLabel(type) {
  return {
    initial_direct_debit: "initial direct debit",
    direct_debit: "direct debit",
    extra_payment: "extra payment",
    friend_payment: "friend payment"
  }[type] || "payment";
}

export function methodLabel(method) {
  return { bank_transfer: "bank transfer", cash: "cash", direct_debit: "direct debit" }[method] || "";
}

export function firstName(member, fallback) {
  return String(member?.name || "").trim().split(/\s+/)[0] || fallback;
}

export function readBody(req) {
  const body = req.body;
  if (body && typeof body === "object") return body;
  if (typeof body === "string" && body) {
    try { return JSON.parse(body); } catch { return {}; }
  }
  return {};
}

// Browsers always send Origin on POST; reject requests from other sites.
export function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  try { return new URL(origin).host === host; } catch { return false; }
}
