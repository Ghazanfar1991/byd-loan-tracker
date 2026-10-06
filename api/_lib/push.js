import webpush from "web-push";
import { db } from "./firebase.js";

let configured = false;

export function vapidPublicKey() {
  return (process.env.VAPID_PUBLIC_KEY || "").trim();
}

function configure() {
  if (configured) return;
  const publicKey = vapidPublicKey();
  const privateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
  const subject = (process.env.VAPID_SUBJECT || "").trim();
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID keys are not configured");
  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
}

// Sends one payload {title, body, url, tag} to every subscription saved for
// this email. Subscriptions the push service reports as gone are deleted.
export async function sendToEmail(email, payload) {
  configure();
  const snap = await db().collection("push_subscriptions")
    .where("email", "==", String(email).toLowerCase()).get();
  const body = JSON.stringify(payload);
  const result = { sent: 0, failed: 0, removed: 0 };

  await Promise.all(snap.docs.map(async doc => {
    try {
      await webpush.sendNotification(doc.get("subscription"), body, { TTL: 60 * 60 * 24 });
      result.sent++;
    } catch (err) {
      if (err?.statusCode === 404 || err?.statusCode === 410) {
        await doc.ref.delete();
        result.removed++;
      } else {
        result.failed++;
        console.error("Push failed", err?.statusCode || err?.message);
      }
    }
  }));
  return result;
}

export function addResults(total, r) {
  total.sent += r.sent;
  total.failed += r.failed;
  total.removed += r.removed;
  return total;
}
