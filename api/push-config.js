import { vapidPublicKey } from "./_lib/push.js";

// Public VAPID key the browser needs for pushManager.subscribe().
export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const publicKey = vapidPublicKey();
  res.setHeader("Cache-Control", "no-store");
  if (!publicKey) return res.status(500).json({ error: "push_not_configured" });
  return res.status(200).json({ publicKey });
}
