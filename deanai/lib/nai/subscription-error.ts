/** Only expose selected error fields; never return the full account response. */
export async function subscriptionFailure(response: Response, token: string) {
  const redact = (value: string) => {
    let safe = token ? value.replaceAll(token, "[Token 已隐藏]") : value;
    safe = safe.replace(/pst-[A-Za-z0-9_-]+/gi, "[Token 已隐藏]")
      .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[Token 已隐藏]");
    return safe.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  };
  const body = (await response.text().catch(() => "")).slice(0, 64000);
  let payload: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch { /* Plain text and HTML errors are handled below. */ }
  const blocked = response.status === 403 && (
    Number(payload.error_code) === 1010 || payload.error_name === "browser_signature_banned" ||
    (response.headers.get("content-type")?.includes("html") && /(?:Error\s*1010|browser.signature.{0,30}(?:banned|blocked))/i.test(body))
  );
  const field = [payload.detail, payload.message, payload.error, payload.title, payload.error_name]
    .find((value) => typeof value === "string" && value.trim());
  const html = response.headers.get("content-type")?.includes("html") || /^\s*</.test(body);
  const fallback = html ? (body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "服务器返回 HTML 拒绝页面")
    : Object.keys(payload).length ? "接口未提供可显示的错误说明" : body;
  const reason = redact(typeof field === "string" ? field : fallback).slice(0, 360);
  const ray = redact(typeof payload.ray_id === "string" ? payload.ray_id : response.headers.get("cf-ray") || "").slice(0, 100);
  const code = typeof payload.error_code === "number" && Number.isFinite(payload.error_code) ? payload.error_code : null;
  const hint = blocked
    ? "Cloudflare 1010：站点按客户端特征拒绝访问。本次会话已暂停额度请求，请联系 NovelAI 确认允许的访问方式。"
    : response.status === 401 ? "认证被拒绝，请检查 Token。"
      : response.status === 403 ? "上游拒绝访问，不代表余额为 0。" : "";
  return {
    blocked: Boolean(blocked),
    message: "HTTP " + response.status + "。" + hint +
      (code && !blocked ? " 错误码：" + code + "。" : "") +
      (reason ? " 接口信息：" + reason : "") + (ray ? " Ray ID：" + ray : "") +
      "（image.novelai.net/user/subscription；未自动重试）",
  };
}
