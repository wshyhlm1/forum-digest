import { readFile } from "node:fs/promises";

import { formatChinaDisplay } from "../shared/time.js";
import type { AppEnv, BatchManifest, PushHistoryEntry, RunConfig, StateBundle } from "../shared/types.js";

export interface NotifyResult {
  state: StateBundle;
  status: "pending" | "sent" | "failed" | "skipped_duplicate";
}

interface BarkRecipient {
  name: string;
  key: string;
}

interface BarkPayload {
  title: string;
  body: string;
  url: string;
  icon: string;
  group: string;
}

function normalizeServer(server: string): string {
  const value = server.trim();
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function parseNamedKeys(input: string): Record<string, string> {
  const recipients: Record<string, string> = {};
  for (const item of input.split(",")) {
    const pair = item.trim();
    if (!pair) {
      continue;
    }
    const index = pair.indexOf(":");
    if (index <= 0) {
      continue;
    }
    const name = pair.slice(0, index).trim();
    const key = pair.slice(index + 1).trim();
    if (name && key) {
      recipients[name] = key;
    }
  }
  return recipients;
}

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\"") {
      if (inQuotes && line[i + 1] === "\"") {
        current += "\"";
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (char === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  result.push(current.trim());
  return result;
}

async function parseRecipientsFromCsv(filePath: string): Promise<Record<string, string>> {
  const text = await readFile(filePath, "utf8");
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return {};
  }

  const header = parseCsvLine(lines[0]).map((item) => item.toLowerCase());
  const nameIndex = header.indexOf("name");
  const addressIndex = header.indexOf("address");
  if (nameIndex < 0 || addressIndex < 0) {
    return {};
  }

  const recipients: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const cols = parseCsvLine(line);
    const name = (cols[nameIndex] ?? "").trim();
    const address = (cols[addressIndex] ?? "").trim();
    if (name && address) {
      recipients[name] = address;
    }
  }
  return recipients;
}

async function resolveRecipients(env: AppEnv): Promise<BarkRecipient[]> {
  const selectedNames = env.barkRecipientNames.length > 0 ? env.barkRecipientNames : ["liyu"];
  const csvRecipients: Record<string, string> =
    env.barkRecipientsFile && env.barkRecipientsFile.trim()
      ? await parseRecipientsFromCsv(env.barkRecipientsFile.trim()).catch(() => ({}))
      : {};
  const namedRecipients = parseNamedKeys(env.barkNamedKeys ?? "");

  const resolved: BarkRecipient[] = [];
  for (const name of selectedNames) {
    const key = csvRecipients[name] ?? namedRecipients[name];
    if (key) {
      resolved.push({ name, key });
    }
  }
  return resolved;
}

function isDuplicateBatch(state: StateBundle, batchId: string): boolean {
  return state.pushHistory.entries.some((entry) => entry.batchId === batchId && entry.status === "sent");
}

function createHistoryEntry(
  batchId: string,
  status: "pending" | "sent" | "failed" | "skipped_duplicate",
  messageUrl: string,
  error?: string
): PushHistoryEntry {
  return {
    batchId,
    status,
    messageUrl,
    sentAt: status === "sent" ? new Date().toISOString() : undefined,
    error
  };
}

function buildPayload(config: RunConfig, manifest: BatchManifest, env: AppEnv): BarkPayload {
  return {
    title: `AI/科技论坛日报已更新 | ${formatChinaDisplay(new Date(config.generatedAt))}`,
    body: `目标日期 ${config.targetDate}，共 ${manifest.storyCount} 条：HN ${manifest.sourceCounts.hackernews}、V2EX ${manifest.sourceCounts.v2ex}。`,
    url: manifest.batchUrl,
    icon: env.barkIconUrl,
    group: "ForumDigest"
  };
}

async function sendBark(recipient: BarkRecipient, payload: BarkPayload, barkServer: string): Promise<void> {
  const endpoint = `${normalizeServer(barkServer)}/push`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      device_key: recipient.key,
      title: payload.title,
      body: payload.body,
      url: payload.url,
      icon: payload.icon,
      group: payload.group
    })
  });

  if (!response.ok) {
    throw new Error(`Bark HTTP ${response.status}`);
  }

  const data = (await response.json().catch(() => ({}))) as { code?: number; message?: string };
  if (typeof data.code === "number" && data.code !== 200) {
    throw new Error(`Bark code ${data.code}: ${data.message ?? "unknown"}`);
  }
}

export async function notifyBatch(
  manifest: BatchManifest,
  _config: RunConfig,
  state: StateBundle,
  env: AppEnv
): Promise<NotifyResult> {
  const messageUrl = manifest.batchUrl;
  if (isDuplicateBatch(state, manifest.batchId)) {
    manifest.push = {
      status: "skipped_duplicate",
      messageUrl,
      error: "batch already sent"
    };
    state.pushHistory.entries.unshift(
      createHistoryEntry(manifest.batchId, "skipped_duplicate", messageUrl, "batch already sent")
    );
    state.pushHistory.entries = state.pushHistory.entries.slice(0, 300);
    return { state, status: "skipped_duplicate" };
  }

  const recipients = await resolveRecipients(env);
  if (recipients.length === 0) {
    manifest.push = {
      status: "failed",
      messageUrl,
      error: "no recipient key found"
    };
    state.pushHistory.entries.unshift(
      createHistoryEntry(manifest.batchId, "failed", messageUrl, "no recipient key found")
    );
    state.pushHistory.entries = state.pushHistory.entries.slice(0, 300);
    return { state, status: "failed" };
  }

  const payload = buildPayload(_config, manifest, env);

  try {
    for (const recipient of recipients) {
      await sendBark(recipient, payload, env.barkServer);
    }
    const successEntry = createHistoryEntry(manifest.batchId, "sent", messageUrl);
    manifest.push = {
      status: "sent",
      messageUrl,
      sentAt: successEntry.sentAt
    };
    state.pushHistory.entries.unshift(successEntry);
    state.pushHistory.entries = state.pushHistory.entries.slice(0, 300);
    return { state, status: "sent" };
  } catch (error) {
    manifest.push = {
      status: "failed",
      messageUrl,
      error: error instanceof Error ? error.message : "unknown notify error"
    };
    state.pushHistory.entries.unshift(
      createHistoryEntry(
        manifest.batchId,
        "failed",
        messageUrl,
        error instanceof Error ? error.message : "unknown notify error"
      )
    );
    state.pushHistory.entries = state.pushHistory.entries.slice(0, 300);
    return { state, status: "failed" };
  }
}

export const __notifyInternals = {
  parseNamedKeys,
  parseCsvLine,
  parseRecipientsFromCsv,
  resolveRecipients,
  buildPayload
};

export type { BarkPayload, BarkRecipient };
