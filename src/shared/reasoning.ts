const DISABLED_REASONING_EFFORTS = new Set(["", "0", "false", "none", "off", "disabled"]);

export function normalizeReasoningEffort(value: string | undefined): string {
  const normalized = value?.trim().toLowerCase() ?? "";
  return DISABLED_REASONING_EFFORTS.has(normalized) ? "" : normalized;
}

export function withQwenReasoningOptions<T extends Record<string, unknown>>(
  body: T,
  reasoningEffort: string | undefined
): T {
  const normalized = normalizeReasoningEffort(reasoningEffort);
  if (!normalized) {
    return body;
  }

  return {
    ...body,
    reasoning_effort: normalized,
    enable_thinking: true
  };
}

export function isReasoningOptionError(status: number): boolean {
  return status === 400 || status === 422;
}
