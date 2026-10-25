const assert = require("node:assert/strict");
const { test } = require("node:test");
const { normalizeColumnOrder, reorderColumn, parseDelimited, escapeCsvValue } = require("../js/csv-viewer.js");

test("以前の設定や壊れた列順はCSVの元の列順へ戻す", () => {
  for (const saved of [undefined, null, [], [1, 1, 2], [0, 1, 3], [0, 1, -1], [0, 1, "2"], [0, 1, 1.5]]) {
    assert.deepEqual(normalizeColumnOrder(saved, 3), [0, 1, 2]);
  }
  assert.deepEqual(normalizeColumnOrder(null, 0), []);
});

test("保存した列順を復元し、元の配列は変更しない", () => {
  const saved = [2, 0, 1];
  const order = normalizeColumnOrder(saved, 3);
  assert.deepEqual(order, saved);
  assert.notEqual(order, saved);
});

test("左右へのドロップと隣接列の▲▼移動", () => {
  const original = [0, 1, 2, 3];
  assert.deepEqual(reorderColumn(original, 0, 3, true), [1, 2, 3, 0]);
  assert.deepEqual(reorderColumn(original, 3, 0), [3, 0, 1, 2]);
  assert.deepEqual(reorderColumn(original, 0, 2), [1, 0, 2, 3]);
  assert.deepEqual(reorderColumn(original, 3, 1, true), [0, 1, 3, 2]);
  assert.deepEqual(reorderColumn(original, 1, 0), [1, 0, 2, 3]);
  assert.deepEqual(reorderColumn(original, 1, 2, true), [0, 2, 1, 3]);
  assert.deepEqual(original, [0, 1, 2, 3]);
});

test("同じ列や存在しない列への移動では列を欠落・重複させない", () => {
  for (const [source, target] of [[1, 1], [9, 0], [0, 9]]) {
    assert.deepEqual(reorderColumn([0, 1, 2], source, target), [0, 1, 2]);
  }
  for (const source of [0, 1, 2, 3]) {
    for (const target of [0, 1, 2, 3]) {
      for (const after of [false, true]) {
        assert.deepEqual(reorderColumn([2, 0, 3, 1], source, target, after).sort(), [0, 1, 2, 3]);
      }
    }
  }
});

test("同名の見出しや非表示列があっても、元の列番号で値と空セルを対応付けられる", () => {
  const parsed = parseDelimited('項目,項目,備考\n001,別の値,\n002,"=1+1",メモ', ',');
  const order = reorderColumn([0, 1, 2], 2, 0);
  const visible = [false, true, true];
  const columns = order.filter((index) => visible[index]);
  assert.deepEqual(columns, [2, 1]);
  const output = parsed.rows.map((row) => columns.map((index) => escapeCsvValue(row[index], true)).join(',')).join('\r\n');
  assert.equal(output, "備考,項目\r\n,別の値\r\nメモ,'=1+1");
  assert.equal(parsed.rows[1][0], '001');
});
