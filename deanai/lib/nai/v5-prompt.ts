import type { CharacterSetting } from "./types";

export type V5QualityTier = "standard" | "light";

const QUALITY_TAGS: Record<V5QualityTier, string> = {
  standard: "very aesthetic, masterpiece, no text",
  light: "very aesthetic, amazing quality, no text",
};

const TEXT_MARKER = /(?:^|[\s,.:\[\]{}、。])(?:text|teXt):(?!:)/i;
const QUOTE_PAIRS = new Map([
  ['"', '"'],
  ["“", "”"],
  ["「", "」"],
  ["'", "'"],
  ["‘", "’"],
]);
const CJK = /[\u3000-\u303f\u3040-\u30ff\uff00-\uff9f\u3400-\u4dbf\u4e00-\u9faf]/gu;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

function splitPromptMix(prompt: string): string[] {
  const chunks: string[] = [];
  let current = "";
  for (let index = 0; index < prompt.length; index += 1) {
    const character = prompt[index];
    if (character === "|" && prompt[index + 1] === "|") {
      current += "||";
      index += 1;
    } else if (character === "|") {
      chunks.push(current);
      current = "";
    } else {
      current += character;
    }
  }
  chunks.push(current);
  return chunks;
}

function appendSuffix(prompt: string, suffix: string) {
  const trimmed = prompt.trim();
  if (!trimmed) return suffix;
  return trimmed.endsWith(",") ? `${trimmed} ${suffix}` : `${trimmed}, ${suffix}`;
}

function applySuffixBeforeText(prompt: string, suffix: string) {
  if (!suffix) return prompt;
  const chunks = splitPromptMix(prompt);
  const first = chunks[0];
  const marker = TEXT_MARKER.exec(first);
  if (marker) {
    const markerIndex = marker.index + marker[0].search(/(?:text|teXt):/i);
    chunks[0] = `${appendSuffix(first.slice(0, markerIndex), suffix)} ${first.slice(markerIndex).trimStart()}`;
  } else {
    chunks[0] = appendSuffix(first, suffix);
  }
  return chunks.join("|");
}

function quoteTexts(prompt: string) {
  const result: string[] = [];
  for (let cursor = 0; cursor < prompt.length; cursor += 1) {
    const opening = prompt[cursor];
    const closing = QUOTE_PAIRS.get(opening);
    const previous = prompt[cursor - 1];
    if (!closing || (opening === "'" && previous && !/[\s,.]/.test(previous))) continue;

    let end = cursor + 1;
    const apostrophe = closing === "'" || closing === "’";
    while (end < prompt.length) {
      if (prompt[end] === closing) {
        const next = prompt[end + 1];
        if (!apostrophe || !next || !LETTER_OR_NUMBER.test(next)) break;
      }
      end += 1;
    }
    if (end >= prompt.length) continue;
    const value = prompt.slice(cursor + 1, end).trim();
    if (value) result.push(value);
    cursor = end;
  }
  return result;
}

function orderedCharacters(characters: CharacterSetting[], useCoords: boolean) {
  const enabled = characters.filter((character) => character.enabled && character.prompt.trim());
  if (!useCoords) return enabled;
  return enabled
    .map((character, index) => ({ character, index }))
    .sort((left, right) =>
      left.character.center.y - right.character.center.y
      || left.character.center.x - right.character.center.x
      || left.index - right.index)
    .map(({ character }) => character);
}

export function buildV5AutoTextBlock(prompt: string, characters: CharacterSetting[], useCoords: boolean) {
  const ordered = orderedCharacters(characters, useCoords);
  if (TEXT_MARKER.test(prompt) || ordered.some((character) => TEXT_MARKER.test(character.prompt))) return null;

  const groups = [quoteTexts(splitPromptMix(prompt)[0]), ...ordered.map((character) => quoteTexts(character.prompt))];
  const combined = groups.flat().join("");
  const cjkRatio = combined ? (combined.match(CJK)?.length ?? 0) / [...combined].length : 0;
  if (cjkRatio > 0.3) groups.forEach((group) => group.reverse());
  const texts = groups.flat();
  return texts.length ? `teXt: ${texts.join("\n\n")}` : null;
}

export type BuildV5PromptOptions = {
  qualityToggle: boolean;
  qualityTier: V5QualityTier;
  transparentBackground: boolean;
  characters: CharacterSetting[];
  useCoords: boolean;
};

export function buildV5Prompt(basePrompt: string, options: BuildV5PromptOptions) {
  const suffix = [
    options.transparentBackground ? "transparent background" : "",
    options.qualityToggle ? QUALITY_TAGS[options.qualityTier] : "",
  ].filter(Boolean).join(", ");
  const withSuffix = applySuffixBeforeText(basePrompt, suffix);
  const autoText = buildV5AutoTextBlock(withSuffix, options.characters, options.useCoords);
  if (!autoText) return { prompt: withSuffix, autoText: null };

  const chunks = splitPromptMix(withSuffix);
  chunks[0] = `${chunks[0].replace(/[\s,]+$/g, "")}, ${autoText}`;
  return { prompt: chunks.join("|"), autoText };
}

export function v5QualityTagHint(enabled: boolean, tier: V5QualityTier) {
  if (!enabled) return 0;
  return tier === "light" ? 3 : 1;
}