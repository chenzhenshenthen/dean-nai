const labels = {
  added: "新增",
  modified: "修改",
  renamed: "识别为改名",
  deleted: "将删除",
  missing: "文件未出现（保留）",
  ambiguous: "待复核歧义",
  unchanged: "内容不变",
};

async function requestJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) {
    const text = await response.text();
    const message = text.match(/<p>(.*?)<\/p>/s)?.[1] || text || `请求失败：${response.status}`;
    throw new Error(message.replace(/<[^>]+>/g, "").trim());
  }
  return response.json();
}

function resetPanel(panel, message = "文件或删除选项已改变，请重新预览。") {
  panel._preview = null;
  panel.querySelector(".apply-button").disabled = true;
  panel.querySelector(".preview-result").hidden = true;
  const status = panel.querySelector(".panel-status");
  status.className = "panel-status";
  status.textContent = message;
}

function itemText(item, key) {
  if (key === "renamed") return `${item.title} → ${item.new_title}`;
  if (key === "modified") return `${item.title}（${(item.changes || []).join("、")}）`;
  if (key === "ambiguous") return `${item.title}（${item.reason}）`;
  return item.title || item.new_title || `资料 #${item.id}`;
}

function renderPreview(panel, payload) {
  const plan = payload.plan;
  const result = panel.querySelector(".preview-result");
  result.replaceChildren();
  const counts = document.createElement("div");
  counts.className = "change-counts";
  ["added", "modified", "renamed", plan.delete_missing ? "deleted" : "missing", "ambiguous", "unchanged"].forEach(key => {
    const node = document.createElement("div");
    node.className = "change-count";
    const number = document.createElement("b");
    number.textContent = plan.counts[key] || 0;
    const label = document.createElement("span");
    label.textContent = labels[key];
    node.append(number, label);
    counts.append(node);
  });
  result.append(counts);

  ["ambiguous", "added", "modified", "renamed", "deleted", "missing", "unchanged"].forEach(key => {
    const items = plan[key] || [];
    if (!items.length) return;
    const details = document.createElement("details");
    details.className = "change-group";
    if (["ambiguous", "deleted", "modified", "renamed"].includes(key)) details.open = true;
    const summary = document.createElement("summary");
    summary.textContent = `${labels[key]} · ${items.length}`;
    const list = document.createElement("ol");
    list.className = "change-list";
    items.forEach(item => {
      const row = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = itemText(item, key);
      row.append(strong);
      if (item.category) {
        const code = document.createElement("code");
        code.textContent = ` · ${item.category}`;
        row.append(code);
      }
      list.append(row);
    });
    details.append(summary, list);
    result.append(details);
  });
  if (!plan.can_apply) {
    const warning = document.createElement("p");
    warning.className = "preview-warning";
    warning.textContent = "存在重名或匹配歧义。为避免覆盖错误卡片，必须先修正更新文件后重新预览。";
    result.append(warning);
  }
  result.hidden = false;
}

async function preview(panel) {
  const input = panel.querySelector(".document-input");
  const file = input.files[0];
  if (!file) return resetPanel(panel, "请先选择一个 DOCX 或 Markdown 文件。");
  const status = panel.querySelector(".panel-status");
  status.className = "panel-status";
  status.textContent = "正在读取并比较更新文件…";
  panel.querySelector(".preview-button").disabled = true;
  try {
    const form = new FormData();
    form.append("kind", panel.dataset.kind);
    form.append("delete_missing", panel.querySelector(".delete-missing").checked ? "1" : "0");
    form.append("document", file);
    const payload = await requestJson("/api/converter/preview", { method: "POST", body: form });
    panel._preview = payload;
    renderPreview(panel, payload);
    panel.querySelector(".apply-button").disabled = !payload.plan.can_apply;
    status.className = "panel-status success";
    status.textContent = `预览完成：${payload.filename}。数据库尚未修改。`;
  } catch (error) {
    panel._preview = null;
    panel.querySelector(".apply-button").disabled = true;
    status.className = "panel-status error";
    status.textContent = error.message;
  } finally {
    panel.querySelector(".preview-button").disabled = false;
  }
}

async function applyUpdate(panel) {
  const payload = panel._preview;
  const file = panel.querySelector(".document-input").files[0];
  if (!payload || !file) return resetPanel(panel);
  const counts = payload.plan.counts;
  const type = panel.dataset.kind === "artist" ? "画师串" : "场景";
  const summary = `确认更新${type}库吗？\n新增 ${counts.added}，修改 ${counts.modified}，改名 ${counts.renamed}，删除 ${counts.deleted}。\n应用前会自动备份当前数据库。`;
  if (!confirm(summary)) return;
  if (counts.deleted > 0 && !confirm(`再次确认：删除 ${counts.deleted} 张卡片，并永久清理无人引用的原图副本和缩略图。共享图片及外部关联原文件保留。自动数据库备份不含图片，如需恢复原图请先创建完整 ZIP 备份。`)) return;
  const status = panel.querySelector(".panel-status");
  const button = panel.querySelector(".apply-button");
  button.disabled = true;
  status.className = "panel-status";
  status.textContent = "正在备份并应用增量更新…";
  try {
    const form = new FormData();
    form.append("kind", panel.dataset.kind);
    form.append("delete_missing", panel.querySelector(".delete-missing").checked ? "1" : "0");
    form.append("document_digest", payload.document_digest);
    form.append("plan_token", payload.plan_token);
    form.append("document", file);
    const result = await requestJson("/api/converter/apply", { method: "POST", body: form });
    panel._preview = null;
    status.className = "panel-status success";
    const cleanup = result.media_cleanup;
    status.textContent = `更新完成。更新前数据库备份：${result.backup}${cleanup ? `；清理 ${cleanup.removed_files} 个副本文件${cleanup.errors.length ? `，${cleanup.errors.length} 项失败，可在空间清理中重试` : ''}` : ''}`;
    panel.querySelector(".preview-result").hidden = true;
  } catch (error) {
    status.className = "panel-status error";
    status.textContent = error.message;
    button.disabled = false;
  }
}

const converterHost = document.querySelector("[data-dean-library-host]");
const converterRoot = converterHost?.shadowRoot || document;
converterRoot.querySelectorAll(".update-panel").forEach(panel => {
  panel.querySelector(".document-input").addEventListener("change", () => resetPanel(panel, "文件已选择，请点击预览。"));
  panel.querySelector(".delete-missing").addEventListener("change", () => resetPanel(panel));
  panel.querySelector(".preview-button").addEventListener("click", () => preview(panel));
  panel.querySelector(".apply-button").addEventListener("click", () => applyUpdate(panel));
});
