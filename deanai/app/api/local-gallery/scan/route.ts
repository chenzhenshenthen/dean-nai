import type { NextRequest } from "next/server";
import { proxyLocalApi } from "@/lib/local-api-proxy";

export const dynamic = "force-dynamic";
export function POST(request: NextRequest) { return proxyLocalApi(request, "/api/local-gallery/scan"); }
