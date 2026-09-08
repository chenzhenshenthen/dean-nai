export const GENERATED_COUNT_KEY = "dean-nai-generated-image-count-v1";
const LEGACY_LEDGER_KEY = "dean-nai-generation-ledger-v2";
const GENERATION_LEDGER_KEY = "dean-nai-generation-ledger-v3";

export type TrackedImageEvent = {
  id: string;
  timestamp: string;
};

export type GenerationLedger = {
  total: number;
  generated: TrackedImageEvent[];
  retained: TrackedImageEvent[];
  generatedSeeded: boolean;
  retainedSeeded: boolean;
};

type ImageIdentity = { id?: number; timestamp: string; filename?: string };

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validEvents(value: unknown): TrackedImageEvent[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is TrackedImageEvent =>
    Boolean(item) && typeof item.id === "string" && item.id.length > 0 && validTimestamp(item.timestamp),
  );
}

export function galleryImageEventId(image: ImageIdentity): string {
  if (typeof image.id === "number") return `gallery:${image.id}`;
  return `legacy:${image.filename || "image"}:${image.timestamp}`;
}

function loadLedger(): GenerationLedger {
  if (typeof window === "undefined") {
    return { total: 0, generated: [], retained: [], generatedSeeded: false, retainedSeeded: false };
  }
  try {
    const current = JSON.parse(window.localStorage.getItem(GENERATION_LEDGER_KEY) || "null") as Partial<GenerationLedger> | null;
    const legacyCount = Number(window.localStorage.getItem(GENERATED_COUNT_KEY) || 0);
    if (current) {
      const generated = validEvents(current.generated);
      const retained = validEvents(current.retained);
      return {
        total: Math.max(Number.isFinite(current.total) ? Number(current.total) : 0, Number.isFinite(legacyCount) ? legacyCount : 0, generated.length),
        generated,
        retained,
        generatedSeeded: current.generatedSeeded === true,
        retainedSeeded: current.retainedSeeded === true,
      };
    }

    const previous = JSON.parse(window.localStorage.getItem(LEGACY_LEDGER_KEY) || "null") as { total?: number; timestamps?: unknown[] } | null;
    const timestamps = Array.isArray(previous?.timestamps) ? previous.timestamps.filter(validTimestamp) : [];
    return {
      total: Math.max(Number(previous?.total) || 0, Number.isFinite(legacyCount) ? legacyCount : 0, timestamps.length),
      generated: timestamps.map((timestamp, index) => ({ id: `legacy-v2:${index}:${timestamp}`, timestamp })),
      retained: [],
      generatedSeeded: false,
      retainedSeeded: false,
    };
  } catch {
    return { total: 0, generated: [], retained: [], generatedSeeded: false, retainedSeeded: false };
  }
}

function saveLedger(value: GenerationLedger): GenerationLedger {
  const generated = [...new Map(value.generated.map((event) => [event.id, event])).values()];
  const retained = [...new Map(value.retained.map((event) => [event.id, event])).values()];
  const normalized = {
    total: Math.max(0, Math.floor(value.total), generated.length),
    generated,
    retained,
    generatedSeeded: value.generatedSeeded,
    retainedSeeded: value.retainedSeeded,
  };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(GENERATION_LEDGER_KEY, JSON.stringify(normalized));
      window.localStorage.setItem(GENERATED_COUNT_KEY, String(normalized.total));
    } catch {
      // Statistics are optional when storage is unavailable or full.
    }
  }
  return normalized;
}

function normalizeSeeds(values: Array<string | ImageIdentity>): TrackedImageEvent[] {
  return values.flatMap((value, index) => {
    if (typeof value === "string") {
      return validTimestamp(value) ? [{ id: `legacy-seed:${index}:${value}`, timestamp: value }] : [];
    }
    return validTimestamp(value.timestamp) ? [{ id: galleryImageEventId(value), timestamp: value.timestamp }] : [];
  });
}

export function initializeGenerationLedger(
  baseline = 0,
  generatedSeeds: Array<string | ImageIdentity> = [],
  retainedBaseline = 0,
  retainedTimestamps: string[] = [],
  retentionSnapshotProvided = false,
): GenerationLedger {
  const ledger = loadLedger();

  if (!ledger.generatedSeeded) {
    const seeds = normalizeSeeds(generatedSeeds);
    const seedTimestamps = new Set(seeds.map((event) => event.timestamp));
    const unmatchedLegacy = ledger.generated.filter((event) => !seedTimestamps.has(event.timestamp));
    ledger.generated = [...seeds, ...unmatchedLegacy];
    ledger.generatedSeeded = true;
  }

  ledger.total = Math.max(ledger.total, Math.max(0, baseline), ledger.generated.length);

  if (retentionSnapshotProvided && !ledger.retainedSeeded) {
    const retainedIds = new Set(ledger.retained.map((event) => event.id));
    const availableByDay = new Map<string, TrackedImageEvent[]>();
    for (const event of ledger.generated) {
      if (retainedIds.has(event.id)) continue;
      const key = event.timestamp.slice(0, 10);
      availableByDay.set(key, [...(availableByDay.get(key) || []), event]);
    }
    const fallback = ledger.generated.filter((event) => !retainedIds.has(event.id));
    let fallbackIndex = 0;
    const targetRetained = Math.min(Math.max(0, retainedBaseline), ledger.total);
    const needed = Math.max(0, targetRetained - ledger.retained.length);
    for (const [index, timestamp] of retainedTimestamps.filter(validTimestamp).slice(0, needed).entries()) {
      const sameDay = availableByDay.get(timestamp.slice(0, 10));
      let generated = sameDay?.shift();
      while (!generated && fallbackIndex < fallback.length) {
        const candidate = fallback[fallbackIndex++];
        if (!retainedIds.has(candidate.id)) generated = candidate;
      }
      const id = generated?.id || `legacy-retained:${index}:${timestamp}`;
      if (retainedIds.has(id)) continue;
      retainedIds.add(id);
      ledger.retained.push({ id, timestamp });
    }
    ledger.retainedSeeded = true;
  }

  return saveLedger(ledger);
}

export function readGenerationLedger(baseline = 0): GenerationLedger {
  const ledger = loadLedger();
  ledger.total = Math.max(ledger.total, Math.max(0, baseline), ledger.generated.length);
  return saveLedger(ledger);
}

export function recordGeneratedImages(values: Array<ImageIdentity> | number): number {
  const ledger = loadLedger();
  const events = Array.isArray(values)
    ? normalizeSeeds(values)
    : Array.from({ length: Math.max(0, Math.floor(values)) }, (_, index) => {
      const timestamp = new Date(Date.now() + index).toISOString();
      return { id: `generated:${timestamp}:${index}`, timestamp };
    });
  const known = new Set(ledger.generated.map((event) => event.id));
  const additions = events.filter((event) => !known.has(event.id));
  ledger.generated.push(...additions);
  ledger.total += additions.length;
  return saveLedger(ledger).total;
}

export function recordRetainedImage(id: string, timestamp = new Date().toISOString()): boolean {
  if (!id || !validTimestamp(timestamp)) return false;
  const ledger = loadLedger();
  if (!ledger.generated.some((event) => event.id === id)) return false;
  if (ledger.retained.some((event) => event.id === id)) return false;
  ledger.retained.push({ id, timestamp });
  saveLedger(ledger);
  return true;
}
