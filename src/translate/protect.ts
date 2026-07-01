export interface ProtectedText {
  text: string;
  placeholders: Map<string, string>;
}

const URL_REGEX = /https?:\/\/[^\s<>"'`]+/gi;
const CODE_BLOCK_REGEX = /```[\s\S]*?```/g;
const INLINE_CODE_REGEX = /`[^`\n]+`/g;
const TOKEN_REGEX = /\b(?:API|SDK|HTTP|HTTPS|URL|JSON|SQL|CPU|GPU|CLI|DNS|TCP|UDP|OAuth|JWT|OpenAI|HN)\b/g;

function applyPlaceholder(input: string, regex: RegExp, placeholders: Map<string, string>, indexRef: { value: number }): string {
  return input.replace(regex, (match) => {
    const key = `__PH_${indexRef.value}__`;
    indexRef.value += 1;
    placeholders.set(key, match);
    return key;
  });
}

export function protectText(raw: string): ProtectedText {
  const placeholders = new Map<string, string>();
  const indexRef = { value: 0 };

  let protectedText = raw;
  protectedText = applyPlaceholder(protectedText, CODE_BLOCK_REGEX, placeholders, indexRef);
  protectedText = applyPlaceholder(protectedText, INLINE_CODE_REGEX, placeholders, indexRef);
  protectedText = applyPlaceholder(protectedText, URL_REGEX, placeholders, indexRef);
  protectedText = applyPlaceholder(protectedText, TOKEN_REGEX, placeholders, indexRef);

  return {
    text: protectedText,
    placeholders
  };
}

export function restoreText(translated: string, placeholders: Map<string, string>): string {
  let output = translated;
  for (const [placeholder, originalValue] of placeholders.entries()) {
    output = output.replaceAll(placeholder, originalValue);
  }
  return output;
}
