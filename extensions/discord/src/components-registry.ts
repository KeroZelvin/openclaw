import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveGlobalMap } from "openclaw/plugin-sdk/text-runtime";
import type { DiscordComponentEntry, DiscordModalEntry } from "./components.js";

const FALLBACK_COMPONENT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_COMPONENT_TTL_MS = (() => {
  const raw = process.env.OPENCLAW_DISCORD_COMPONENT_DEFAULT_TTL_MS;
  if (!raw) {
    return FALLBACK_COMPONENT_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return FALLBACK_COMPONENT_TTL_MS;
  }
  return parsed;
})();

const REGISTRY_PATH = (() => {
  const raw = process.env.OPENCLAW_DISCORD_COMPONENT_REGISTRY_PATH?.trim();
  if (raw) {
    return raw;
  }
  return path.join(os.homedir(), ".openclaw", "state", "discord-components-registry.json");
})();

type PersistedRegistry = {
  version: 1;
  components: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
};

const DISCORD_COMPONENT_ENTRIES_KEY = Symbol.for("openclaw.discord.componentEntries");
const DISCORD_MODAL_ENTRIES_KEY = Symbol.for("openclaw.discord.modalEntries");

const componentEntries = resolveGlobalMap<string, DiscordComponentEntry>(
  DISCORD_COMPONENT_ENTRIES_KEY,
);
const modalEntries = resolveGlobalMap<string, DiscordModalEntry>(DISCORD_MODAL_ENTRIES_KEY);
let loaded = false;
let lastLoadedMtimeMs = 0;

function isExpired(entry: { expiresAt?: number }, now: number) {
  return typeof entry.expiresAt === "number" && entry.expiresAt <= now;
}

function normalizeEntryTimestamps<T extends { createdAt?: number; expiresAt?: number }>(
  entry: T,
  now: number,
  ttlMs: number,
): T {
  const createdAt = entry.createdAt ?? now;
  const expiresAt = entry.expiresAt ?? createdAt + ttlMs;
  return { ...entry, createdAt, expiresAt };
}

function upsertComponent(entry: DiscordComponentEntry, now: number): void {
  if (isExpired(entry, now)) {
    return;
  }
  const existing = componentEntries.get(entry.id);
  const existingCreatedAt = existing?.createdAt ?? 0;
  const incomingCreatedAt = entry.createdAt ?? 0;
  if (!existing || incomingCreatedAt >= existingCreatedAt) {
    componentEntries.set(entry.id, entry);
  }
}

function upsertModal(entry: DiscordModalEntry, now: number): void {
  if (isExpired(entry, now)) {
    return;
  }
  const existing = modalEntries.get(entry.id);
  const existingCreatedAt = existing?.createdAt ?? 0;
  const incomingCreatedAt = entry.createdAt ?? 0;
  if (!existing || incomingCreatedAt >= existingCreatedAt) {
    modalEntries.set(entry.id, entry);
  }
}

function pruneExpired(now: number): void {
  for (const [id, entry] of componentEntries) {
    if (isExpired(entry, now)) {
      componentEntries.delete(id);
    }
  }
  for (const [id, entry] of modalEntries) {
    if (isExpired(entry, now)) {
      modalEntries.delete(id);
    }
  }
}

function loadFromDisk(params?: { force?: boolean }): void {
  const force = params?.force === true;
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(REGISTRY_PATH);
  } catch {
    stat = null;
  }

  if (!force && loaded && stat && stat.mtimeMs <= lastLoadedMtimeMs) {
    return;
  }
  if (!force && loaded && !stat) {
    return;
  }

  loaded = true;
  if (!stat) {
    lastLoadedMtimeMs = 0;
    return;
  }

  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, "utf8");
  } catch {
    return;
  }

  let parsed: PersistedRegistry | null = null;
  try {
    parsed = JSON.parse(raw) as PersistedRegistry;
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object") {
    return;
  }

  const now = Date.now();
  for (const entry of Array.isArray(parsed.components) ? parsed.components : []) {
    if (!entry || typeof entry.id !== "string") {
      continue;
    }
    upsertComponent(entry, now);
  }
  for (const entry of Array.isArray(parsed.modals) ? parsed.modals : []) {
    if (!entry || typeof entry.id !== "string") {
      continue;
    }
    upsertModal(entry, now);
  }

  pruneExpired(now);
  lastLoadedMtimeMs = stat.mtimeMs;
}

function saveToDisk(): void {
  const now = Date.now();
  pruneExpired(now);

  const payload: PersistedRegistry = {
    version: 1,
    components: [...componentEntries.values()],
    modals: [...modalEntries.values()],
  };

  const dir = path.dirname(REGISTRY_PATH);
  const tempPath = `${REGISTRY_PATH}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify(payload));
    fs.renameSync(tempPath, REGISTRY_PATH);
    try {
      const stat = fs.statSync(REGISTRY_PATH);
      lastLoadedMtimeMs = stat.mtimeMs;
    } catch {
      // ignore
    }
  } catch {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // ignore
    }
  }
}

export function registerDiscordComponentEntries(params: {
  entries: DiscordComponentEntry[];
  modals: DiscordModalEntry[];
  ttlMs?: number;
  messageId?: string;
}): void {
  loadFromDisk();
  const now = Date.now();
  const ttlMs = params.ttlMs ?? DEFAULT_COMPONENT_TTL_MS;
  for (const entry of params.entries) {
    const normalized = normalizeEntryTimestamps(
      { ...entry, messageId: params.messageId ?? entry.messageId },
      now,
      ttlMs,
    );
    componentEntries.set(entry.id, normalized);
  }
  for (const modal of params.modals) {
    const normalized = normalizeEntryTimestamps(
      { ...modal, messageId: params.messageId ?? modal.messageId },
      now,
      ttlMs,
    );
    modalEntries.set(modal.id, normalized);
  }
  saveToDisk();
}

export function resolveDiscordComponentEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordComponentEntry | null {
  loadFromDisk();
  let entry = componentEntries.get(params.id);
  if (!entry) {
    // Cross-process sync: allow gateway to see entries registered by CLI workers.
    loadFromDisk({ force: true });
    entry = componentEntries.get(params.id);
    if (!entry) {
      return null;
    }
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    componentEntries.delete(params.id);
    saveToDisk();
    return null;
  }
  if (params.consume !== false) {
    componentEntries.delete(params.id);
    saveToDisk();
  }
  return entry;
}

export function resolveDiscordModalEntry(params: {
  id: string;
  consume?: boolean;
}): DiscordModalEntry | null {
  loadFromDisk();
  let entry = modalEntries.get(params.id);
  if (!entry) {
    // Cross-process sync: allow gateway to see entries registered by CLI workers.
    loadFromDisk({ force: true });
    entry = modalEntries.get(params.id);
    if (!entry) {
      return null;
    }
  }
  const now = Date.now();
  if (isExpired(entry, now)) {
    modalEntries.delete(params.id);
    saveToDisk();
    return null;
  }
  if (params.consume !== false) {
    modalEntries.delete(params.id);
    saveToDisk();
  }
  return entry;
}

export function clearDiscordComponentEntries(): void {
  componentEntries.clear();
  modalEntries.clear();
  loaded = true;
  lastLoadedMtimeMs = 0;
  saveToDisk();
}
