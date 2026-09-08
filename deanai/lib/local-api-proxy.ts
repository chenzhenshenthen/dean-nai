import { NextRequest, NextResponse } from "next/server";

const LOCAL_API = process.env.DEAN_NAI_LOCAL_API || "http://127.0.0.1:5179";

export async function proxyLocalApi(request: NextRequest, pathname: string) {
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();
    const upstream = await fetch(`${LOCAL_API}${pathname}`, {
      method: request.method,
      headers: body ? { "content-type": request.headers.get("content-type") || "application/json" } : undefined,
      body,
      cache: "no-store",
    });
    const headers = new Headers();
    for (const name of [
      "content-type",
      "cache-control",
      "content-disposition",
      "etag",
      "last-modified",
    ]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new NextResponse(await upstream.arrayBuffer(), {
      status: upstream.status,
      headers,
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Local service unavailable" }, { status: 503 });
  }
}
