/**
 * Claude Code failures that go away on their own (usage limits, rate limits, overload).
 * Shared by planning and coding so both treat them as "try again later", never as a real failure.
 */

/** Temporary failure text inside a CLI error result or a wrapped error message. */
export const TEMPORARY_CLI_FAILURE =
  /usage limit|session limit|you'?ve hit your [\w -]{1,30} limit|rate.?limit|too many requests|\b429\b|overloaded|\b529\b|try again later/i;

/** The CLI's limit banner returned as the entire answer (e.g. "You've hit your 5-hour limit · resets 10:40pm"). */
export const CLI_LIMIT_BANNER = /^(you'?ve hit your [\w -]{1,30} limit|claude ai usage limit reached)\b.{0,120}$/i;

/** True when an error message (possibly wrapped by the pipeline) is a temporary Claude limit. */
export function isTemporaryClaudeFailure(message: string | undefined): boolean {
  return !!message && TEMPORARY_CLI_FAILURE.test(message);
}

/** "resets 10:40pm (Asia/Calcutta)" from a limit message, if present. */
export function limitResetHint(message: string | undefined): string | undefined {
  return message?.match(/resets? [^\n.;]{1,40}/i)?.[0];
}
