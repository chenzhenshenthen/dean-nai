import type { NextRequest } from "next/server";
import { proxyLocalApi } from "@/lib/local-api-proxy";

export const dynamic = "force-dynamic";
export function GET(request: NextRequest) { return proxyLocalApi(request, "/api/integrated-settings"); }
export function PUT(request: NextRequest) { return proxyLocalApi(request, "/api/integrated-settings"); }
