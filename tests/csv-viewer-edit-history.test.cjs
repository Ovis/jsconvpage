const assert = require("node:assert/strict");
const { test } = require("node:test");
const { EditHistory } = require("../js/csv-viewer.js");

test("別々のセルの編集を逆順に戻し、同じ順序でやり直せる", () => {
  const history = new EditHistory();
  const first = { rowIndex: 0, columnIndex: 1, before: "元の値", after: "編集した値" };
  const second = { rowIndex: 2, columnIndex: 0, before: "001", after: "002" };
  history.record(first);
  history.record(second);
  assert.deepEqual(history.undo(), second);
  assert.deepEqual(history.undo(), first);
  assert.equal(history.undo(), null);
  assert.equal(history.canUndo, false);
  assert.deepEqual(history.redo(), first);
  assert.deepEqual(history.redo(), second);
  assert.equal(history.redo(), null);
  assert.equal(history.canRedo, false);
});

test("元に戻したあとに別の編集をすると、古いやり直し履歴を破棄する", () => {
  const history = new EditHistory();
  history.record({ before: "a", after: "b" });
  history.record({ before: "b", after: "c" });
  history.undo();
  history.record({ before: "b", after: "d" });
  assert.equal(history.canRedo, false);
  assert.equal(history.undo().before, "b");
  assert.equal(history.undo().before, "a");
});

test("値が変わっていない確定は履歴に追加せず、やり直し履歴も残す", () => {
  const history = new EditHistory();
  history.record({ before: "a", after: "b" });
  history.undo();
  history.record({ before: "a", after: "a" });
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, true);
  assert.equal(history.redo().after, "b");
});

test("連続入力をまとめても、開始時と終了時の値・カーソル位置を復元できる", () => {
  const history = new EditHistory();
  history.record({ before: "", after: "a", beforeSelection: { anchor: 0, focus: 0 }, afterSelection: { anchor: 1, focus: 1 } });
  history.record({ before: "a", after: "ab", beforeSelection: { anchor: 1, focus: 1 }, afterSelection: { anchor: 2, focus: 2 } }, true);
  const change = history.undo();
  assert.equal(change.before, "");
  assert.equal(change.after, "ab");
  assert.deepEqual(change.beforeSelection, { anchor: 0, focus: 0 });
  assert.deepEqual(change.afterSelection, { anchor: 2, focus: 2 });
  assert.equal(history.canUndo, false);
});

test("HTML・改行・空文字は変換せず保持し、元の変更記録を上書きしない", () => {
  const history = new EditHistory();
  const markup = '<script>alert("test")</script>\n"引用",001';
  const change = { before: markup, after: "" };
  history.record(change);
  assert.equal(history.undo().before, markup);
  assert.equal(history.redo().after, "");
  assert.deepEqual(change, { before: markup, after: "" });
});

test("履歴上限とクリアが効き、新しいCSVに以前の履歴を持ち越さない", () => {
  const history = new EditHistory(2);
  history.record({ before: "a", after: "b" });
  history.record({ before: "b", after: "c" });
  history.record({ before: "c", after: "d" });
  assert.equal(history.undo().before, "c");
  assert.equal(history.undo().before, "b");
  assert.equal(history.undo(), null);
  history.clear();
  assert.equal(history.canUndo, false);
  assert.equal(history.canRedo, false);
});
