// Offline tests of production helpers. No browser database or user image is opened.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";

function compile(file, expose = "") {
  const source = readFileSync(new URL("../" + file, import.meta.url), "utf8") + expose;
  const context = vm.createContext({ exports: {}, require() { return { DEFAULT_SETTINGS: {} }; } });
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, context);
  return context.exports;
}
const rating = compile("lib/rating-filter.ts");
test("评分离散选择，不自动包含中间半星", () => {
  assert.equal(rating.ratingMatches("8,10", 8), true);
  assert.equal(rating.ratingMatches("8,10", 9), false);
  assert.equal(rating.ratingMatches("8,10", 10), true);
  assert.equal(rating.ratingMatches("9,10", 9), true);
  assert.equal(rating.ratingMatches("10", 9), false);
});
test("评分迁移、去重、未评分和全选", () => {
  assert.equal(rating.normalizeRatingFilter("gte9"), "10,9");
  assert.equal(rating.normalizeRatingFilter("8,10,8,bad"), "10,8");
  assert.equal(rating.ratingMatches("unrated,10", null), true);
  assert.equal(rating.ratingMatches("", null), true);
  assert.equal(rating.ratingMatches("10", null), false);
});
const gallery = compile("lib/db/gallery.ts", "\nexport { pruneTrash };");

function navigation(overrides = {}) {
  const source = readFileSync(new URL("../components/local-gallery.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const navigateDetail = useCallback(");
  const end = source.indexOf("\n  useEffect(", start);
  assert.ok(start >= 0 && end > start);
  let selected = { id: 60 };
  const loads = [];
  const context = vm.createContext({
    useCallback: (callback) => callback,
    detailIndex: 0, visible: [selected], loading: false,
    detailNavigationBusy: { current: false },
    page: 1, total: 121, pageSize: 60, detail: selected,
    load: async (page) => { loads.push(page); return [{ id: 61 }, { id: 120 }]; },
    setDetail: (update) => { selected = typeof update === "function" ? update(selected) : update; },
    ...overrides,
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end) + "\nglobalThis.navigate = navigateDetail;", {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText, context);
  return { context, loads, selected: () => selected };
}
test("详情页最后一张向右跨到下一页首张", async () => {
  const run = navigation();
  await run.context.navigate(1);
  assert.deepEqual(run.loads, [2]);
  assert.equal(run.selected().id, 61);
});
test("详情页第一张向左跨到上一页末张", async () => {
  const run = navigation({ page: 2 });
  await run.context.navigate(-1);
  assert.deepEqual(run.loads, [1]);
  assert.equal(run.selected().id, 120);
});
test("第一页向左与加载中不触发越界翻页", async () => {
  const first = navigation();
  await first.context.navigate(-1);
  assert.deepEqual(first.loads, []);
  const busy = navigation({ loading: true });
  await busy.context.navigate(1);
  assert.deepEqual(busy.loads, []);
});
test("跨页请求失败时保留当前详情且解锁", async () => {
  const run = navigation({ load: async () => undefined });
  await run.context.navigate(1);
  assert.equal(run.selected().id, 60);
  assert.equal(run.context.detailNavigationBusy.current, false);
});

for (const count of [0, 10, 20, 21, 150]) {
  test("回收站按索引保留最新20项：原有" + count, () => {
    const rows = Array.from({ length: count }, (_, i) => count - i);
    const deleted = [];
    const request = { result: null };
    let position = 0;
    function advance() {
      request.result = position < rows.length ? { primaryKey: rows[position++], continue: advance } : null;
      request.onsuccess();
    }
    gallery.pruneTrash({
      index(name) {
        assert.equal(name, "deletedAt");
        return { openKeyCursor(range, direction) {
          assert.equal(range, null); assert.equal(direction, "prev"); return request;
        } };
      },
      delete(id) { deleted.push(id); },
    });
    advance();
    assert.deepEqual(deleted, rows.slice(20));
    assert.equal(gallery.IMAGE_TRASH_LIMIT, 20);
  });
}
