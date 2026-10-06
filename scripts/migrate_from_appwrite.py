"""One-off migration: Appwrite export -> Firestore.

1. Export Appwrite data into ./appwrite-export (git-ignored):
     appwrite tablesdb list-rows --database-id carloan --table-id <table> --limit 1000 --raw
     appwrite users list --raw
     appwrite teams list-memberships --team-id <team> --raw
     appwrite storage list-files --bucket-id payment-receipts --raw
2. Run:  python3 scripts/migrate_from_appwrite.py [--dry-run]
   (set FIRESTORE_EMULATOR_HOST=127.0.0.1:8085 to load a local emulator instead)

Writes go through the Firestore REST API with your gcloud credentials (admin
access, so security rules do not apply). Re-running is safe: every document
keeps its Appwrite ID and is overwritten with the same values.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

PROJECT = "byd-loan-tracker"
EXPORT = Path(__file__).resolve().parent.parent / "appwrite-export"
BASE = f"projects/{PROJECT}/databases/(default)/documents"
DRY_RUN = "--dry-run" in sys.argv


def load(name):
    return json.loads((EXPORT / f"{name}.json").read_text())


def to_value(v):
    if v is None:
        return {"nullValue": None}
    if isinstance(v, bool):
        return {"booleanValue": v}
    if isinstance(v, int):
        return {"integerValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, list):
        return {"arrayValue": {"values": [to_value(x) for x in v]}}
    return {"stringValue": str(v)}


def strip_meta(row):
    return {k: v for k, v in row.items() if not k.startswith("$")}


def main():
    users = {u["$id"]: u for u in load("users")["users"]}
    email_of = {uid: u["email"].strip().lower() for uid, u in users.items()}

    files = load("files")
    if files["total"]:
        sys.exit(f"Appwrite bucket has {files['total']} receipt files; add receipt migration before running.")

    docs = []  # (path, fields)

    for m in load("memberships")["memberships"]:
        user = users[m["userId"]]
        docs.append((f"members/{email_of[m['userId']]}", {
            "name": user["name"],
            "role": "owner" if "owner" in m["roles"] else "friend",
            "appwrite_user_id": m["userId"],
        }))

    for row in load("settings")["rows"]:
        data = strip_meta(row)
        data["owner_email"] = email_of.get(row["owner_user_id"])
        data["appwrite_created_at"] = row["$createdAt"]
        data["appwrite_updated_at"] = row["$updatedAt"]
        docs.append((f"settings/{row['$id']}", data))

    for table in ("financier_payments", "friend_payments"):
        for row in load(table)["rows"]:
            data = strip_meta(row)
            if data.get("paid_by"):
                data["paid_by"] = email_of.get(data["paid_by"], data["paid_by"])
            if data.get("proof_file_id"):
                sys.exit(f"{table}/{row['$id']} references a receipt; add receipt migration first.")
            docs.append((f"{table}/{row['$id']}", data))

    print(f"{len(docs)} documents to write:")
    for prefix in ("members", "settings", "financier_payments", "friend_payments"):
        print(f"  {prefix}: {sum(1 for p, _ in docs if p.startswith(prefix + '/'))}")
    if DRY_RUN:
        return

    emulator = os.environ.get("FIRESTORE_EMULATOR_HOST")
    if emulator:
        host, token = f"http://{emulator}", "owner"  # emulator admin token bypasses rules
    else:
        host = "https://firestore.googleapis.com"
        token = subprocess.check_output(["gcloud", "auth", "print-access-token"], text=True).strip()
    for i in range(0, len(docs), 400):
        writes = [{"update": {"name": f"{BASE}/{path}",
                              "fields": {k: to_value(v) for k, v in fields.items()}}}
                  for path, fields in docs[i:i + 400]]
        req = urllib.request.Request(
            f"{host}/v1/{BASE}:commit",
            data=json.dumps({"writes": writes}).encode(),
            method="POST",
            headers={"Authorization": f"Bearer {token}", "x-goog-user-project": PROJECT,
                     "Content-Type": "application/json"})
        try:
            result = json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            sys.exit(f"Commit failed ({e.code}): {e.read().decode()}")
        print(f"  committed {len(result.get('writeResults', []))} writes")
    print("Done.")


if __name__ == "__main__":
    main()
