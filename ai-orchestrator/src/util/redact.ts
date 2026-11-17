/**
 * Removes credentials from text before it is posted to Jira, logged, or stored.
 * Applied to every error message the pipeline surfaces: a failing command or HTTP call can
 * echo its own auth header or token back in the error text.
 */
const PATTERNS: Array<[RegExp, string]> = [
  // HTTP auth headers: "Authorization: Basic xxx", "Authorization: Bearer xxx"
  [/(authorization\s*[:=]\s*)(basic|bearer|token)\s+[A-Za-z0-9+/=._~-]{6,}/gi, '$1$2 [REDACTED]'],
  // Bare "Basic <base64>" / "Bearer <token>"
  [/\b(basic|bearer)\s+[A-Za-z0-9+/=._~-]{16,}/gi, '$1 [REDACTED]'],
  // Atlassian API tokens
  [/\bATATT[A-Za-z0-9_\-=]{20,}/g, '[REDACTED-ATLASSIAN-TOKEN]'],
  [/\bATCTT[A-Za-z0-9_\-=]{20,}/g, '[REDACTED-ATLASSIAN-TOKEN]'],
  // Anthropic keys
  [/\bsk-ant-[A-Za-z0-9]{2,6}-[A-Za-z0-9_\-]{16,}/g, '[REDACTED-ANTHROPIC-KEY]'],
  // Credentials in URLs: https://user:secret@host
  [/(https?:\/\/[^\s/:@]+):[^\s/@]+@/gi, '$1:[REDACTED]@'],
  // key=value / key: value for obviously secret names
  // (any name ENDING in one of these, e.g. BITBUCKET_TOKEN, JIRA_API_TOKEN, db_password)
  [/\b([A-Za-z0-9_-]*?(?:token|secret|password|passwd|apikey|api_key|access[_-]?key))(\s*[:=]\s*)["']?[^\s"',;]{6,}/gi, '$1$2[REDACTED]']
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const [re, repl] of PATTERNS) out = out.replace(re, repl);
  return out;
}

/** Error message with secrets removed. */
export function safeErrorMessage(err: unknown): string {
  return redactSecrets(err instanceof Error ? err.message : String(err));
}
