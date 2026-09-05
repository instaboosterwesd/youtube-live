import { randomBytes, randomUUID } from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { firebaseDelete, firebaseGet, firebasePut } from "../lib/firebase-rest";

const router: IRouter = Router();
const dayMs = 24 * 60 * 60 * 1000;

type LicenseRecord = {
  id: string;
  key: string;
  name: string;
  createdAt: string;
  expiresAt: string;
  active: boolean;
};

type LicenseMap = Record<string, Omit<LicenseRecord, "id">>;

function configuredOwnerPassword(): string {
  return process.env.OWNER_PASSWORD?.trim() || "traderp1wer";
}

function ownerAuthorized(req: Request): boolean {
  return req.header("x-owner-password") === configuredOwnerPassword();
}

function validClientId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function validKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,160}$/.test(value.trim());
}

function daysValue(value: unknown, fallback = 30): number {
  const days = typeof value === "number" ? value : Number(value);
  return Number.isInteger(days) && days >= 1 && days <= 3650 ? days : fallback;
}

function publicLicense(record: LicenseRecord, clientId?: string) {
  return {
    licenseId: record.id,
    key: record.key,
    name: record.name,
    expiresAt: record.expiresAt,
    active: record.active && new Date(record.expiresAt).getTime() > Date.now(),
    clientId,
  };
}

async function findLicense(key: string): Promise<LicenseRecord | null> {
  const map = (await firebaseGet<LicenseMap | null>("licenses")) ?? {};
  const entry = Object.entries(map).find(([, record]) => record.key === key.trim());
  return entry ? { id: entry[0], ...entry[1] } : null;
}

function licenseIsActive(record: LicenseRecord): boolean {
  return record.active && new Date(record.expiresAt).getTime() > Date.now();
}

function requireOwner(req: Request, res: Response): boolean {
  if (ownerAuthorized(req)) return true;
  res.status(401).json({ error: "Owner password is incorrect." });
  return false;
}

async function saveLicense(record: LicenseRecord): Promise<void> {
  const { id, ...value } = record;
  await firebasePut(`licenses/${encodeURIComponent(id)}`, value);
}

router.get("/licenses", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  try {
    const map = (await firebaseGet<LicenseMap | null>("licenses")) ?? {};
    const licenses = Object.entries(map)
      .map(([id, record]) => publicLicense({ id, ...record }))
      .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt));
    res.json({ licenses });
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "License list failed");
    res.status(502).json({ error: "Could not read licenses from Firebase." });
  }
});

router.post("/licenses", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (!name) {
    res.status(400).json({ error: "Enter a name for this license." });
    return;
  }
  const now = Date.now();
  const record: LicenseRecord = {
    id: `lic-${randomUUID()}`,
    key: `SD-${randomBytes(6).toString("hex").toUpperCase()}`,
    name,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + daysValue(req.body?.days) * dayMs).toISOString(),
    active: true,
  };
  try {
    await saveLicense(record);
    res.status(201).json(publicLicense(record));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "License create failed");
    res.status(502).json({ error: "Could not create the license in Firebase." });
  }
});

router.delete("/licenses/:licenseId", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  try {
    await firebaseDelete(`licenses/${encodeURIComponent(req.params.licenseId)}`);
    await firebaseDelete(`workspaces/${encodeURIComponent(req.params.licenseId)}`);
    res.json({ licenseId: req.params.licenseId, deleted: true });
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "License delete failed");
    res.status(502).json({ error: "Could not delete the license from Firebase." });
  }
});

router.post("/licenses/:licenseId/renew", async (req, res): Promise<void> => {
  if (!requireOwner(req, res)) return;
  try {
    const raw = await firebaseGet<Omit<LicenseRecord, "id"> | null>(`licenses/${encodeURIComponent(req.params.licenseId)}`);
    if (!raw) {
      res.status(404).json({ error: "License not found." });
      return;
    }
    const record: LicenseRecord = { id: req.params.licenseId, ...raw };
    const base = Math.max(Date.now(), new Date(record.expiresAt).getTime());
    record.expiresAt = new Date(base + daysValue(req.body?.days) * dayMs).toISOString();
    record.active = true;
    await saveLicense(record);
    res.json(publicLicense(record));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Owner license renew failed");
    res.status(502).json({ error: "Could not renew the license in Firebase." });
  }
});

router.post("/licenses/validate", async (req, res): Promise<void> => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const clientId = req.body?.clientId;
  if (!validKey(key) || !validClientId(clientId)) {
    res.status(400).json({ error: "Enter a valid license key." });
    return;
  }
  try {
    const record = await findLicense(key);
    if (!record || !licenseIsActive(record)) {
      res.status(403).json({ error: "This license is invalid or expired." });
      return;
    }
    res.json(publicLicense(record, clientId));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "License validation failed");
    res.status(502).json({ error: "Could not validate the license right now." });
  }
});

router.post("/licenses/workspace/get", async (req, res): Promise<void> => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const clientId = req.body?.clientId;
  if (!validKey(key) || !validClientId(clientId)) {
    res.status(400).json({ error: "A license key and browser id are required." });
    return;
  }
  try {
    const record = await findLicense(key);
    if (!record || !licenseIsActive(record)) {
      res.status(403).json({ error: "This license is invalid or expired." });
      return;
    }
    const data = await firebaseGet<unknown>(`workspaces/${encodeURIComponent(record.id)}/${encodeURIComponent(clientId)}`);
    res.json({ license: publicLicense(record, clientId), data: data ?? null });
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Workspace load failed");
    res.status(502).json({ error: "Could not load this license workspace." });
  }
});

router.put("/licenses/workspace", async (req, res): Promise<void> => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const clientId = req.body?.clientId;
  if (!validKey(key) || !validClientId(clientId) || !req.body?.data || typeof req.body.data !== "object") {
    res.status(400).json({ error: "A license key, browser id, and workspace data are required." });
    return;
  }
  try {
    const record = await findLicense(key);
    if (!record || !licenseIsActive(record)) {
      res.status(403).json({ error: "This license is invalid or expired." });
      return;
    }
    await firebasePut(`workspaces/${encodeURIComponent(record.id)}/${encodeURIComponent(clientId)}`, req.body.data);
    res.json({ saved: true });
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "Workspace save failed");
    res.status(502).json({ error: "Could not save this license workspace." });
  }
});

router.post("/licenses/renew", async (req, res): Promise<void> => {
  const key = typeof req.body?.key === "string" ? req.body.key.trim() : "";
  const clientId = req.body?.clientId;
  if (!validKey(key) || !validClientId(clientId)) {
    res.status(400).json({ error: "A license key and browser id are required." });
    return;
  }
  try {
    const record = await findLicense(key);
    if (!record) {
      res.status(404).json({ error: "This license key was not found." });
      return;
    }
    const base = Math.max(Date.now(), new Date(record.expiresAt).getTime());
    record.expiresAt = new Date(base + daysValue(req.body?.days) * dayMs).toISOString();
    record.active = true;
    await saveLicense(record);
    res.json(publicLicense(record, clientId));
  } catch (error) {
    req.log.error({ error: error instanceof Error ? error.message : "unknown" }, "User license renew failed");
    res.status(502).json({ error: "Could not renew this license right now." });
  }
});

export default router;
