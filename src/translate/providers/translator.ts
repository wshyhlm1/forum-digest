import { restoreText, protectText } from "../protect.js";

export interface ProviderResult {
  text: string;
  provider: "openai" | "google";
}

const GOOGLE_INITIAL_CHUNK_SIZE = 5_000;
const GOOGLE_MIN_CHUNK_SIZE = 80;
const GOOGLE_RETRYABLE_STATUS = new Set([400, 413, 414]);

class GoogleTranslateHttpError extends Error {
  constructor(readonly status: number) {
    super(`Google translate failed: ${status}`);
    this.name = "GoogleTranslateHttpError";
  }
}

function normalizeOpenAiBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

function buildChatCompletionUrls(baseUrl: string): string[] {
  const normalized = normalizeOpenAiBaseUrl(baseUrl);
  if (normalized.endsWith("/v1") || normalized.includes("/compatible-mode/v1")) {
    return [`${normalized}/chat/completions`];
  }
  return [`${normalized}/v1/chat/completions`, `${normalized}/chat/completions`];
}

async function translateWithOpenAi(
  text: string,
  options: { apiKey: string; baseUrl: string; model: string }
): Promise<string> {
  if (!options.apiKey) {
    throw new Error("OPENAI_API_KEY is empty");
  }

  let response: Response | null = null;
  let lastStatus = "";
  for (const url of buildChatCompletionUrls(options.baseUrl)) {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${options.apiKey}`
      },
      body: JSON.stringify({
        model: options.model || "qwen3.6-plus",
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "Translate user text into Simplified Chinese. Keep placeholders like __PH_0__ unchanged. Preserve HTML tags when present. Do not add explanations."
          },
          {
            role: "user",
            content: text
          }
        ]
      }),
      signal: AbortSignal.timeout(45_000)
    });
    if (response.ok) {
      break;
    }
    lastStatus = `${response.status} ${response.statusText}`;
  }

  if (!response?.ok) {
    throw new Error(`OpenAI-compatible translate failed: ${lastStatus || "no response"}`);
  }

  const payload = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
  };

  const content = payload.choices?.[0]?.message?.content;
  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (Array.isArray(content)) {
    const stitched = content
      .map((entry) => entry?.text ?? "")
      .join("")
      .trim();
    if (stitched) {
      return stitched;
    }
  }

  throw new Error("OpenAI translate returned empty content");
}

function splitTextIntoChunks(text: string, maxChunkSize: number): string[] {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(cursor + maxChunkSize, text.length);
    if (end < text.length) {
      const slice = text.slice(cursor, end);
      const separators = ["\n\n", "\n", ". ", "! ", "? ", "。", "！", "？", ";", "；", ",", "，", " "];
      let bestBoundary = -1;

      for (const separator of separators) {
        const index = slice.lastIndexOf(separator);
        if (index >= 0) {
          bestBoundary = Math.max(bestBoundary, index + separator.length);
        }
      }

      if (bestBoundary >= Math.floor(maxChunkSize * 0.5)) {
        end = cursor + bestBoundary;
      }
    }

    chunks.push(text.slice(cursor, end));
    cursor = end;
  }

  return chunks;
}

async function requestGoogleTranslation(text: string): Promise<string> {
  const endpoint = new URL("https://translate.googleapis.com/translate_a/single");
  endpoint.searchParams.set("client", "gtx");
  endpoint.searchParams.set("sl", "auto");
  endpoint.searchParams.set("tl", "zh-CN");
  endpoint.searchParams.set("dt", "t");
  endpoint.searchParams.set("q", text);

  const response = await fetch(endpoint);
  if (!response.ok) {
    throw new GoogleTranslateHttpError(response.status);
  }

  const payload = (await response.json()) as unknown[];
  const chunks = (payload?.[0] as unknown[]) || [];
  const translated = chunks
    .map((row) => ((row as unknown[])[0] ?? "").toString())
    .join("")
    .trim();
  return translated || text;
}

function shouldRetryGoogleTranslation(error: unknown): boolean {
  return error instanceof GoogleTranslateHttpError
    && GOOGLE_RETRYABLE_STATUS.has(error.status);
}

async function translateWithGoogleChunked(text: string, chunkSize: number): Promise<string> {
  const chunks = splitTextIntoChunks(text, chunkSize);

  if (chunks.length === 1) {
    try {
      return await requestGoogleTranslation(text);
    } catch (error) {
      const nextChunkSize = Math.max(GOOGLE_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
      const canRetryByChunking = shouldRetryGoogleTranslation(error)
        && text.length > GOOGLE_MIN_CHUNK_SIZE
        && nextChunkSize < chunkSize;
      if (canRetryByChunking) {
        return translateWithGoogleChunked(text, nextChunkSize);
      }
      throw error;
    }
  }

  const translatedChunks: string[] = [];
  for (const chunk of chunks) {
    try {
      translatedChunks.push(await requestGoogleTranslation(chunk));
    } catch (error) {
      if (shouldRetryGoogleTranslation(error) && chunk.length > GOOGLE_MIN_CHUNK_SIZE) {
        const nextChunkSize = Math.max(GOOGLE_MIN_CHUNK_SIZE, Math.floor(chunkSize / 2));
        translatedChunks.push(await translateWithGoogleChunked(chunk, nextChunkSize));
      } else {
        throw error;
      }
    }
  }

  return translatedChunks.join("");
}

async function translateWithGoogle(text: string): Promise<string> {
  return translateWithGoogleChunked(text, GOOGLE_INITIAL_CHUNK_SIZE);
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function translateTextWithFallback(
  raw: string,
  options: { apiKey: string; baseUrl: string; model: string }
): Promise<ProviderResult> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { text: raw, provider: "google" };
  }

  const { text: protectedText, placeholders } = protectText(raw);

  try {
    const openAiResult = await translateWithOpenAi(protectedText, options);
    return {
      text: restoreText(openAiResult, placeholders),
      provider: "openai"
    };
  } catch (openAiError) {
    try {
      const googleResult = await translateWithGoogle(protectedText);
      return {
        text: restoreText(googleResult, placeholders),
        provider: "google"
      };
    } catch (googleError) {
      console.warn(
        "[translate] OpenAI and Google providers both failed; returning source text.",
        {
          openai: toErrorMessage(openAiError),
          google: toErrorMessage(googleError)
        }
      );
      return {
        text: raw,
        provider: "google"
      };
    }
  }
}
