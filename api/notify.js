// POST /api/notify — push a "payment logged" notification to the other member.
//
// Env: FIREBASE_SERVICE_ACCOUNT (service-account JSON, raw or base64),
//      VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...).
//
// Auth: `Authorization: Bearer <Firebase ID token>`; the email must be verified
// and have a members/{email} doc.
// Body: { collection: "friend_payments" | "financier_payments", docId }
//   The doc is read server-side and, if its status is "paid", every member
//   other than the caller is notified. Any other status is a no-op.
// Body: { test: true }
//   Sends a test notification to the caller's own devices.
// Responds { ok, sent, ... }. Same-origin only; other methods get 405.
import { db, loadMembers, requireMember } from "./_lib/firebase.js";
import { addResults, sendToEmail } from "./_lib/push.js";
import { firstName, formatDate, isDirectDebit, isSameOrigin, methodLabel, money, readBody, typeLabel } from "./_lib/loan.js";

const COLLECTIONS = new Set(["friend_payments", "financier_payments"]);

export function paymentMessage(row, { collection, docId, actorName }) {
  const method = methodLabel(row.payment_method);
  let body = `${money(row.amount_cents)} ${typeLabel(row.type)} for ${formatDate(row.due_date || row.paid_date)}`;
  if (method && !isDirectDebit(row.type)) body += ` (${method})`;
  if (row.proof_file_id) body += " · receipt attached";
  return {
    title: `${actorName} logged a payment`,
    body,
    url: "/",
    tag: `paid-${collection}-${docId}`
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!isSameOrigin(req)) return res.status(403).json({ error: "forbidden_origin" });

  try {
    const caller = await requireMember(req);
    const body = readBody(req);

    if (body.test === true) {
      const result = await sendToEmail(caller.email, {
        title: "Notifications are on ✅",
        body: "You'll get payment reminders and updates on this device.",
        url: "/",
        tag: "test"
      });
      return res.status(200).json({ ok: true, ...result });
    }

    const { collection, docId } = body;
    if (!COLLECTIONS.has(collection) || typeof docId !== "string" || !docId
        || docId.length > 200 || docId.includes("/")) {
      return res.status(400).json({ error: "invalid_request" });
    }

    const snap = await db().collection(collection).doc(docId).get();
    if (!snap.exists) return res.status(404).json({ error: "not_found" });
    const row = snap.data();
    if (row.status !== "paid") return res.status(200).json({ ok: true, skipped: "not_paid", sent: 0 });

    const members = await loadMembers();
    const actor = members.find(m => m.email === String(row.paid_by || "").toLowerCase())
      || { name: caller.member.name };
    const payload = paymentMessage(row, { collection, docId, actorName: firstName(actor, "Someone") });

    const recipients = members.filter(m => m.email !== caller.email);
    const total = { sent: 0, failed: 0, removed: 0 };
    for (const r of recipients) addResults(total, await sendToEmail(r.email, payload));
    return res.status(200).json({ ok: true, recipients: recipients.length, ...total });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.code });
    console.error("notify failed", err);
    return res.status(500).json({ error: "server_error" });
  }
}
