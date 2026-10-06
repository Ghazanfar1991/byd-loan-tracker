// GET /api/cron-reminders — daily payment reminders (Vercel Cron, see vercel.json).
//
// Env: CRON_SECRET (Vercel sends `Authorization: Bearer $CRON_SECRET`),
//      FIREBASE_SERVICE_ACCOUNT (service-account JSON, raw or base64),
//      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...).
//
// Using today's date in Australia/Sydney:
//   friend_payment overdue   → friend ("please send …") and owner ("… is N days overdue")
//   friend_payment due today → friend; due tomorrow → friend (heads-up)
//   extra_payment overdue or due today → owner
// Direct debits are auto-paid and never remind; paid/skipped/missed rows are ignored.
// Each member gets at most one notification per run summarising everything.
// Responds with counts only.
import { timingSafeEqual } from "node:crypto";
import { db, loadMembers } from "./_lib/firebase.js";
import { sendToEmail } from "./_lib/push.js";
import { addDays, daysBetween, firstName, formatDate, money, statusForRow, todayKey } from "./_lib/loan.js";

function authorized(req) {
  const secret = process.env.CRON_SECRET || "";
  const given = Buffer.from(req.headers?.authorization || "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return Boolean(secret) && given.length === expected.length && timingSafeEqual(given, expected);
}

const ago = days => days === 1 ? "yesterday" : `${days} days ago`;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// Returns [{email, role, items:[{kind, cents, due_date, title, line}]}] for members with something actionable.
export function buildReminders(rows, members, today) {
  const tomorrow = addDays(today, 1);
  const owners = members.filter(m => m.role === "owner");
  const friends = members.filter(m => m.role === "friend");
  const ownerName = firstName(owners[0], "the owner");
  const friendName = firstName(friends[0], "Your friend");
  const ownerItems = [], friendItems = [];

  for (const row of rows) {
    if (!row.due_date) continue;
    const status = statusForRow(row, today);
    const cents = Number(row.amount_cents) || 0;
    const amount = money(cents);
    const due = formatDate(row.due_date, { year: false });
    const late = daysBetween(row.due_date, today);

    if (row.type === "friend_payment") {
      if (status === "overdue") {
        friendItems.push({ kind: "overdue", cents, due_date: row.due_date, title: "Payment overdue",
          line: `Please send ${amount} to ${ownerName} (due ${due}, ${ago(late)})` });
        ownerItems.push({ kind: "overdue", cents, due_date: row.due_date, title: "Friend payment overdue",
          line: `${friendName}'s ${amount} payment is ${plural(late, "day")} overdue` });
      } else if (status === "due") {
        friendItems.push({ kind: "due", cents, due_date: row.due_date, title: "Payment due today",
          line: `Send ${amount} to ${ownerName}` });
      } else if (status === "scheduled" && row.due_date === tomorrow) {
        friendItems.push({ kind: "soon", cents, due_date: row.due_date, title: `Heads-up: ${amount} due tomorrow`,
          line: `Your payment to ${ownerName} is due tomorrow (${due})` });
      }
    } else if (row.type === "extra_payment") {
      if (status === "overdue") {
        ownerItems.push({ kind: "overdue", cents, due_date: row.due_date, title: "Extra payment overdue",
          line: `Extra payment of ${amount} to the financier is overdue (due ${due})` });
      } else if (status === "due") {
        ownerItems.push({ kind: "due", cents, due_date: row.due_date, title: "Extra payment due today",
          line: `Extra payment of ${amount} to the financier is due today` });
      }
    }
  }

  const out = [];
  for (const m of owners) if (ownerItems.length) out.push({ email: m.email, role: "owner", items: ownerItems });
  for (const m of friends) if (friendItems.length) out.push({ email: m.email, role: "friend", items: friendItems });
  return out;
}

export function summarise(items) {
  const sorted = [...items].sort((a, b) => a.due_date.localeCompare(b.due_date));
  if (sorted.length === 1) {
    return { title: sorted[0].title, body: sorted[0].line, url: "/", tag: "reminders" };
  }
  const total = money(sorted.reduce((sum, i) => sum + i.cents, 0));
  const kinds = new Set(sorted.map(i => i.kind));
  const what = kinds.size > 1 ? "need attention"
    : { overdue: "overdue", due: "due today", soon: "due tomorrow" }[sorted[0].kind];
  return {
    title: `${sorted.length} payments ${what} · ${total} total`,
    body: sorted.map(i => i.line).join("\n"),
    url: "/",
    tag: "reminders"
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!authorized(req)) return res.status(401).json({ error: "unauthorized" });

  try {
    const today = todayKey();
    const until = addDays(today, 1);
    const [members, ...snaps] = await Promise.all([
      loadMembers(),
      db().collection("friend_payments").where("due_date", "<=", until).get(),
      db().collection("financier_payments").where("due_date", "<=", until).get()
    ]);
    const rows = snaps.flatMap(s => s.docs.map(d => d.data()));

    const reminders = buildReminders(rows, members, today);
    const notifications = [];
    for (const r of reminders) {
      const result = await sendToEmail(r.email, summarise(r.items));
      notifications.push({ role: r.role, items: r.items.length, ...result });
    }
    return res.status(200).json({ ok: true, today, notifications });
  } catch (err) {
    console.error("cron-reminders failed", err);
    return res.status(500).json({ error: "server_error" });
  }
}
