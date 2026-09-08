/** Clean copy/paste wrappers only; never decode, truncate, or invent credentials. */
export function normalizeNovelAIToken(raw: string): string {
  let value = raw.trim();
  for (let i = 0; i < 4; i++) {
    const previous = value;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1).trim();
    }
    value = value.replace(/^Bearer\s+/i, "").trim();
    if (value === previous) break;
  }
  return value.replace(/\s+/g, "");
}

/** A format check cannot prove completeness or validity; only NovelAI can. */
export function hasNovelAITokenFormat(token: string): boolean {
  return token.startsWith("pst-") && token.length > 4 && token.length <= 4096
    && !/[\s"'*•…]/.test(token) && !token.includes("...");
}
