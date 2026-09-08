const MAX_BODY_LENGTH = 32_000;
const MAX_FIELD_LENGTH = 12_000;

function clipped(value: unknown) {
  return String(value ?? "").slice(0, MAX_FIELD_LENGTH);
}

export async function POST(request: Request) {
  const raw = await request.text();
  if (raw.length > MAX_BODY_LENGTH) return new Response(null, { status: 413 });

  try {
    const payload = JSON.parse(raw) as Record<string, unknown>;
    const kind = clipped(payload.kind || "error");
    const location = payload.source
      ? ` at ${clipped(payload.source)}:${Number(payload.line) || 0}:${Number(payload.column) || 0}`
      : "";
    const stack = clipped(payload.stack);
    console.error(`[browser:${kind}] ${clipped(payload.message)}${location}${stack ? `\n${stack}` : ""}`);
    return new Response(null, { status: 204 });
  } catch {
    return Response.json({ error: "Invalid client log payload" }, { status: 400 });
  }
}
