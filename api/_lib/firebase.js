import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// FIREBASE_SERVICE_ACCOUNT holds the service-account JSON, either raw or base64.
function readServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || "").trim();
  if (!raw) return null;
  const json = raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString("utf8");
  const account = JSON.parse(json);
  if (account.private_key) account.private_key = account.private_key.replace(/\\n/g, "\n");
  return account;
}

function adminApp() {
  const existing = getApps()[0];
  if (existing) return existing;
  const account = readServiceAccount();
  if (account) return initializeApp({ credential: cert(account), projectId: account.project_id });
  // Local testing against the emulators needs no credentials.
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    return initializeApp({ projectId: process.env.GCLOUD_PROJECT || "byd-loan-tracker" });
  }
  throw new Error("FIREBASE_SERVICE_ACCOUNT is not set");
}

export const db = () => getFirestore(adminApp());
export const adminAuth = () => getAuth(adminApp());

export class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// Verifies the Firebase ID token and returns the caller's membership.
export async function requireMember(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers?.authorization || "");
  if (!match) throw new HttpError(401, "missing_token");

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(match[1]);
  } catch {
    throw new HttpError(401, "invalid_token");
  }
  if (!decoded.email || decoded.email_verified !== true) throw new HttpError(403, "email_not_verified");

  const email = decoded.email.toLowerCase();
  const snap = await db().collection("members").doc(email).get();
  if (!snap.exists) throw new HttpError(403, "not_a_member");
  return { email, member: snap.data() };
}

export async function loadMembers() {
  const snap = await db().collection("members").get();
  return snap.docs.map(d => ({ email: d.id.toLowerCase(), name: d.get("name") || "", role: d.get("role") }));
}
