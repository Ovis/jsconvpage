(() => {
  "use strict";

  const MAX_FILE_BYTES = 50 * 1024 * 1024;
  const INITIAL_RENDER_COUNT = 300;
  const RENDER_BATCH_COUNT = 500;
  const MAX_REPORTED_ISSUES = 30;
  const FORMULA_PREFIX_PATTERN = /^[\t\r ]*[=+\-@]/;
  const SAMPLE_CSV = [
    "書籍コード,タイトル,棚番号,在庫数,更新日",
    "DEMO-001,青いノート,S-01,24,2026-10-01",
    "DEMO-002,城塞都市の案内図,S-03,7,2026-09-28",
    "DEMO-003,まだ見ぬ星の図鑑,S-02,12,2026-09-25",
    "DEMO-004,試作用カタログ,S-04,0,2026-09-20"
  ].join("\n");

  class CsvLoadError extends Error {
    constructor(message, details = []) {
      super(message);
      this.name = "CsvLoadError";
      this.details = details;
    }
  }

  function detectDelimiter(text) {
    const candidates = [",", "\t", ";"];
    const scores = new Map(candidates.map((candidate) => [candidate, 0]));
    let inQuotes = false;
    let recordCount = 0;

    for (let index = 0; index < text.length && recordCount < 40; index += 1) {
      const character = text[index];
      if (character === '"') {
        if (inQuotes && text[index + 1] === '"') {
          index += 1;
        } else {
          inQuotes = !inQuotes;
        }
        continue;
      }
      if (!inQuotes && scores.has(character)) {
        scores.set(character, scores.get(character) + 1);
      }
      if (!inQuotes && (character === "\n" || character === "\r")) {
        if (character === "\r" && text[index + 1] === "\n") index += 1;
        recordCount += 1;
      }
    }

    return candidates.reduce((best, candidate) => (
      scores.get(candidate) > scores.get(best) ? candidate : best
    ), candidates[0]);
  }

  function parseDelimited(text, delimiter) {
    const rows = [];
    const rowLines = [];
    const errors = [];
    const warnings = [];
    let row = [];
    let field = "";
    let state = "field-start";
    let physicalLine = 1;
    let rowStartLine = 1;
    let ignoredWhitespaceAfterQuote = false;

    const reportError = (message) => {
      if (errors.length < MAX_REPORTED_ISSUES) {
        errors.push(`物理行 ${physicalLine}: ${message}`);
      }
    };

    const finishField = () => {
      row.push(field);
      field = "";
      state = "field-start";
    };

    const finishRow = () => {
      finishField();
      rows.push(row);
      rowLines.push(rowStartLine);
      row = [];
      rowStartLine = physicalLine + 1;
    };

    for (let index = 0; index < text.length; index += 1) {
      const character = text[index];
      const isCrLf = character === "\r" && text[index + 1] === "\n";
      const isLineBreak = character === "\n" || character === "\r";

      if (state === "quoted") {
        if (character === '"') {
          if (text[index + 1] === '"') {
            field += '"';
            index += 1;
          } else {
            state = "after-quote";
          }
        } else if (isLineBreak) {
          field += "\n";
          if (isCrLf) index += 1;
          physicalLine += 1;
        } else {
          field += character;
        }
        continue;
      }

      if (state === "after-quote") {
        if (character === delimiter) {
          finishField();
        } else if (isLineBreak) {
          finishRow();
          if (isCrLf) index += 1;
          physicalLine += 1;
        } else if (character === " " || character === "\t") {
          ignoredWhitespaceAfterQuote = true;
        } else {
          reportError(`閉じ引用符の後に区切り文字ではない文字「${character}」があります。`);
          field += character;
          state = "unquoted";
        }
        continue;
      }

      if (state === "field-start") {
        if (character === delimiter) {
          finishField();
        } else if (isLineBreak) {
          finishRow();
          if (isCrLf) index += 1;
          physicalLine += 1;
        } else if (character === '"') {
          state = "quoted";
        } else {
          field = character;
          state = "unquoted";
        }
        continue;
      }

      if (character === delimiter) {
        finishField();
      } else if (isLineBreak) {
        finishRow();
        if (isCrLf) index += 1;
        physicalLine += 1;
      } else if (character === '"') {
        reportError("引用符はフィールドの先頭に置くか、引用符内で2個重ねる必要があります。");
        field += character;
      } else {
        field += character;
      }
    }

    if (state === "quoted") {
      reportError("引用符で囲まれたフィールドが閉じられていません。");
    }

    if (text.length > 0 && (row.length > 0 || field !== "" || state !== "field-start")) {
      finishField();
      rows.push(row);
      rowLines.push(rowStartLine);
    }

    const nonBlankRows = [];
    const nonBlankRowLines = [];
    let blankRowCount = 0;
    rows.forEach((currentRow, index) => {
      if (currentRow.length === 1 && currentRow[0] === "") {
        blankRowCount += 1;
      } else {
        nonBlankRows.push(currentRow);
        nonBlankRowLines.push(rowLines[index]);
      }
    });

    if (blankRowCount > 0) {
      warnings.push(`空行 ${blankRowCount} 行を読み飛ばしました。`);
    }
    if (ignoredWhitespaceAfterQuote) {
      warnings.push("閉じ引用符の後にある空白を読み飛ばしました。");
    }

    return {
      rows: nonBlankRows,
      rowLines: nonBlankRowLines,
      errors,
      warnings
    };
  }

  function validateParsedRows(parsed) {
    const errors = [...parsed.errors];
    const warnings = [...parsed.warnings];

    if (parsed.rows.length === 0) {
      errors.push("データがありません。見出し行を含むCSV・TSVを指定してください。");
      return { errors, warnings };
    }

    const columnCount = parsed.rows[0].length;
    parsed.rows.forEach((row, index) => {
      if (index === 0) return;
      if (row.length !== columnCount && errors.length < MAX_REPORTED_ISSUES) {
        const difference = columnCount - row.length;
        const detail = difference > 0
          ? `区切り文字が ${difference} 個不足しています。末尾セルを空にする場合は、行末にも区切り文字が必要です。末尾に値がある場合は、途中の列が抜けていないか確認してください。`
          : `区切り文字が ${Math.abs(difference)} 個多くあります。値に区切り文字を含める場合は、その値を引用符で囲んでください。`;
        errors.push(
          `物理行 ${parsed.rowLines[index]}: ${row.length} 列として読み取りましたが、見出し行は ${columnCount} 列です。${detail}`
        );
      }
    });

    const headers = parsed.rows[0];
    const emptyHeaders = headers.reduce((count, value) => count + (value.trim() === "" ? 1 : 0), 0);
    if (emptyHeaders > 0) {
      warnings.push(`名前のない列が ${emptyHeaders} 列あります。画面上では「無題列」と表示します。`);
    }

    const seen = new Set();
    const duplicates = new Set();
    headers.forEach((header) => {
      const normalized = header.trim().toLocaleLowerCase("ja");
      if (!normalized) return;
      if (seen.has(normalized)) duplicates.add(header);
      seen.add(normalized);
    });
    if (duplicates.size > 0) {
      warnings.push(`同じ名前の列があります: ${Array.from(duplicates).join("、")}`);
    }

    if (parsed.rows.length === 1) {
      warnings.push("見出し行だけがあり、データ行はありません。");
    }

    return { errors, warnings };
  }

  function decodeBytes(bytes, requestedEncoding) {
    const hasUtf8Bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const candidates = requestedEncoding === "auto"
      ? (hasUtf8Bom ? ["utf-8"] : ["utf-8", "shift_jis"])
      : [requestedEncoding];
    const failures = [];

    for (const encoding of candidates) {
      try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        return { text: text.replace(/^\uFEFF/, ""), encoding };
      } catch (error) {
        failures.push(`${encoding}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    throw new CsvLoadError(
      "文字コードを判定できませんでした。",
      ["文字コードをUTF-8またはShift_JISに指定して、もう一度読み込んでください。", ...failures]
    );
  }

  function createElement(tagName, options = {}) {
    const element = document.createElement(tagName);
    if (options.className) element.className = options.className;
    if (options.text !== undefined) element.textContent = String(options.text);
    if (options.type) element.type = options.type;
    return element;
  }

  function hashHeaders(headers) {
    const text = headers.join("\u001f");
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
  }

  function escapeCsvValue(value, safeForSpreadsheet) {
    let output = String(value ?? "");
    if (safeForSpreadsheet && FORMULA_PREFIX_PATTERN.test(output)) {
      output = `'${output}`;
    }
    if (/[",\r\n]/.test(output)) {
      return `"${output.replace(/"/g, '""')}"`;
    }
    return output;
  }

  function normalizeColumnOrder(order, columnCount) {
    if (Array.isArray(order) && order.length === columnCount &&
        new Set(order).size === columnCount &&
        order.every((index) => Number.isInteger(index) && index >= 0 && index < columnCount)) {
      return [...order];
    }
    return Array.from({ length: columnCount }, (_, index) => index);
  }

  function reorderColumn(order, sourceColumn, targetColumn, after = false) {
    if (sourceColumn === targetColumn || !order.includes(sourceColumn) || !order.includes(targetColumn)) {
      return [...order];
    }
    const result = order.filter((columnIndex) => columnIndex !== sourceColumn);
    const position = result.indexOf(targetColumn) + (after ? 1 : 0);
    result.splice(position, 0, sourceColumn);
    return result;
  }

  class EditHistory {
    constructor(limit = 100) {
      this.limit = limit;
      this.clear();
    }

    get canUndo() { return this.undoStack.length > 0; }
    get canRedo() { return this.redoStack.length > 0; }

    clear() {
      this.undoStack = [];
      this.redoStack = [];
    }

    record(change, merge = false) {
      if (change.before === change.after) return;
      const previous = this.undoStack.at(-1);
      if (merge && !this.canRedo && previous && previous.after === change.before &&
          previous.rowIndex === change.rowIndex && previous.columnIndex === change.columnIndex) {
        previous.after = change.after;
        previous.afterSelection = change.afterSelection;
      } else {
        this.undoStack.push({ ...change });
        if (this.undoStack.length > this.limit) this.undoStack.shift();
      }
      this.redoStack = [];
    }

    undo() {
      const change = this.undoStack.pop();
      if (!change) return null;
      this.redoStack.push(change);
      return change;
    }

    redo() {
      const change = this.redoStack.pop();
      if (!change) return null;
      this.undoStack.push(change);
      return change;
    }
  }

  const exportedFunctions = {
    detectDelimiter,
    parseDelimited,
    validateParsedRows,
    escapeCsvValue,
    normalizeColumnOrder,
    reorderColumn,
    EditHistory
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = exportedFunctions;
  }

  if (typeof document === "undefined") return;

  document.addEventListener("DOMContentLoaded", () => {
    const elements = {
      dropZone: document.getElementById("drop-zone"),
      openFileButton: document.getElementById("open-file-button"),
      fileInput: document.getElementById("file-input"),
      openPasteButton: document.getElementById("open-paste-button"),
      encodingSelect: document.getElementById("encoding-select"),
      delimiterSelect: document.getElementById("delimiter-select"),
      sourceSummary: document.getElementById("source-summary"),
      issuePanel: document.getElementById("issue-panel"),
      issueTitle: document.getElementById("issue-title"),
      issueSummary: document.getElementById("issue-summary"),
      issueList: document.getElementById("issue-list"),
      closeIssueButton: document.getElementById("close-issue-button"),
      viewer: document.getElementById("viewer"),
      globalSearch: document.getElementById("global-search"),
      rowCount: document.getElementById("row-count"),
      toggleFiltersButton: document.getElementById("toggle-filters-button"),
      openColumnsButton: document.getElementById("open-columns-button"),
      openColumnOrderButton: document.getElementById("open-column-order-button"),
      columnOrderDialog: document.getElementById("column-order-dialog"),
      columnOrderList: document.getElementById("column-order-list"),
      columnOrderStatus: document.getElementById("column-order-status"),
      resetColumnOrderButton: document.getElementById("reset-column-order-button"),
      hideCellButton: document.getElementById("hide-cell-button"),
      hideRowsButton: document.getElementById("hide-rows-button"),
      openHiddenButton: document.getElementById("open-hidden-button"),
      hiddenCount: document.getElementById("hidden-count"),
      undoButton: document.getElementById("undo-button"),
      redoButton: document.getElementById("redo-button"),
      freezeCount: document.getElementById("freeze-count"),
      densitySelect: document.getElementById("density-select"),
      wrapToggle: document.getElementById("wrap-toggle"),
      resetViewButton: document.getElementById("reset-view-button"),
      exportButton: document.getElementById("export-button"),
      exportDialog: document.getElementById("export-dialog"),
      exportSummary: document.getElementById("export-summary"),
      exportSafeToggle: document.getElementById("export-safe-toggle"),
      confirmExportButton: document.getElementById("confirm-export-button"),
      selectionStatus: document.getElementById("selection-status"),
      tableRegion: document.getElementById("table-region"),
      table: document.getElementById("data-table"),
      tableColumns: document.getElementById("table-columns"),
      tableHead: document.getElementById("table-head"),
      tableBody: document.getElementById("table-body"),
      emptyResult: document.getElementById("empty-result"),
      renderMoreButton: document.getElementById("render-more-button"),
      pasteDialog: document.getElementById("paste-dialog"),
      pasteInput: document.getElementById("paste-input"),
      loadPasteButton: document.getElementById("load-paste-button"),
      columnsDialog: document.getElementById("columns-dialog"),
      columnSearch: document.getElementById("column-search"),
      columnList: document.getElementById("column-list"),
      showAllColumnsButton: document.getElementById("show-all-columns-button"),
      hideAllColumnsButton: document.getElementById("hide-all-columns-button"),
      hiddenDialog: document.getElementById("hidden-dialog"),
      hiddenList: document.getElementById("hidden-list"),
      restoreAllButton: document.getElementById("restore-all-button")
    };

    const state = {
      headers: [],
      displayHeaders: [],
      rows: [],
      rowLines: [],
      sourceName: "",
      sourceEncoding: "",
      sourceDelimiter: ",",
      rawBytes: null,
      rawText: null,
      visibleColumns: [],
      columnOrder: [],
      columnWidths: [],
      columnFilters: [],
      filtersVisible: false,
      globalQuery: "",
      sortColumn: null,
      sortDirection: "none",
      freezeCount: 1,
      density: "normal",
      wrap: false,
      safeExport: true,
      hiddenRows: new Set(),
      hiddenCells: new Set(),
      selectedRows: new Set(),
      selectedCell: null,
      viewRows: [],
      renderLimit: INITIAL_RENDER_COUNT,
      datasetStorageKey: "",
      isSample: false
    };

    const collator = new Intl.Collator("ja", { numeric: true, sensitivity: "base" });
    const editHistory = new EditHistory();
    let searchTimer = null;
    let draggedColumn = null;
    let suppressSortUntil = 0;
    let cellEdit = null;
    let pendingEditRefresh = false;
    let editRefreshTimer = null;
    let pointerIsDown = false;

    function displayDelimiter(delimiter) {
      if (delimiter === "\t") return "タブ区切り";
      if (delimiter === ";") return "セミコロン区切り";
      return "カンマ区切り";
    }

    function showIssues(type, title, summary, details) {
      elements.issuePanel.className = `issue-panel is-${type}`;
      elements.issueTitle.textContent = title;
      elements.issueSummary.textContent = summary;
      elements.issueList.replaceChildren();
      details.slice(0, MAX_REPORTED_ISSUES).forEach((detail) => {
        elements.issueList.append(createElement("li", { text: detail }));
      });
      if (details.length > MAX_REPORTED_ISSUES) {
        elements.issueList.append(createElement("li", { text: `ほか ${details.length - MAX_REPORTED_ISSUES} 件` }));
      }
      elements.issueList.hidden = details.length === 0;
      elements.issuePanel.hidden = false;
    }

    function hideIssues() {
      elements.issuePanel.hidden = true;
      elements.issueList.replaceChildren();
    }

    function clearDatasetForError(sourceName) {
      finishCellEdit(false);
      editHistory.clear();
      updateHistoryButtons();
      pendingEditRefresh = false;
      state.headers = [];
      state.displayHeaders = [];
      state.rows = [];
      state.rowLines = [];
      state.viewRows = [];
      elements.viewer.hidden = true;
      elements.sourceSummary.textContent = sourceName ? `${sourceName} / 読み込み失敗` : "読み込み失敗";
    }

    function handleLoadError(error, sourceName = "") {
      clearDatasetForError(sourceName);
      const message = error instanceof Error ? error.message : String(error);
      const details = error instanceof CsvLoadError ? error.details : [];
      showIssues(
        "error",
        "データを読み込めませんでした",
        message,
        details.length > 0 ? details : ["入力内容と読み込み設定を確認してください。"]
      );
    }

    function parseText(text, source) {
      clearTimeout(searchTimer);
      finishCellEdit(false);
      pendingEditRefresh = false;
      editHistory.clear();
      updateHistoryButtons();
      if (text.length > MAX_FILE_BYTES) {
        throw new CsvLoadError(
          "テキストが大きすぎます。",
          [`読み込み上限は ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MBです。`]
        );
      }

      const selectedDelimiter = elements.delimiterSelect.value;
      const delimiter = selectedDelimiter === "auto"
        ? detectDelimiter(text)
        : (selectedDelimiter === "tab" ? "\t" : selectedDelimiter);
      const parsed = parseDelimited(text.replace(/^\uFEFF/, ""), delimiter);
      const validation = validateParsedRows(parsed);

      if (validation.errors.length > 0) {
        throw new CsvLoadError(
          "CSV・TSVの構造に問題があります。データは表示していません。",
          validation.errors
        );
      }

      const headers = parsed.rows[0];
      const displayHeaders = headers.map((header, index) => (
        header.trim() === "" ? `無題列 ${index + 1}` : header
      ));

      state.headers = headers;
      state.displayHeaders = displayHeaders;
      state.rows = parsed.rows.slice(1);
      state.rowLines = parsed.rowLines.slice(1);
      state.sourceName = source.name;
      state.sourceEncoding = source.encoding;
      state.sourceDelimiter = delimiter;
      state.isSample = Boolean(source.isSample);
      state.datasetStorageKey = `csv-viewer-settings:${hashHeaders(headers)}`;
      state.visibleColumns = headers.map(() => true);
      state.columnOrder = normalizeColumnOrder(null, headers.length);
      state.columnWidths = headers.map(() => 160);
      state.columnFilters = headers.map(() => "");
      state.globalQuery = "";
      state.sortColumn = null;
      state.sortDirection = "none";
      state.hiddenRows = new Set();
      state.hiddenCells = new Set();
      state.selectedRows = new Set();
      state.selectedCell = null;
      state.renderLimit = INITIAL_RENDER_COUNT;
      elements.globalSearch.value = "";
      loadViewSettings();
      syncViewControls();
      renderAll();

      const encodingText = source.encoding ? ` / ${source.encoding === "shift_jis" ? "Shift_JIS" : "UTF-8"}` : "";
      const sampleText = source.isSample ? "（架空サンプル）" : "";
      elements.sourceSummary.textContent = `${source.name}${sampleText} / ${state.rows.length} 行・${headers.length} 列${encodingText} / ${displayDelimiter(delimiter)}`;
      elements.viewer.hidden = false;

      if (validation.warnings.length > 0) {
        showIssues(
          "warning",
          "読み込み時の注意",
          "データは表示できますが、確認したほうがよい点があります。",
          validation.warnings
        );
      } else {
        hideIssues();
      }
    }

    function loadViewSettings() {
      try {
        const raw = localStorage.getItem(state.datasetStorageKey);
        if (!raw) return;
        const saved = JSON.parse(raw);
        state.columnOrder = normalizeColumnOrder(saved.columnOrder, state.headers.length);
        if (Array.isArray(saved.visibleColumns) && saved.visibleColumns.length === state.headers.length) {
          state.visibleColumns = saved.visibleColumns.map(Boolean);
        }
        if (Array.isArray(saved.columnWidths) && saved.columnWidths.length === state.headers.length) {
          state.columnWidths = saved.columnWidths.map((width) => Math.min(600, Math.max(80, Number(width) || 160)));
        }
        if (Number.isInteger(saved.freezeCount)) state.freezeCount = Math.max(0, saved.freezeCount);
        if (["compact", "normal", "comfortable"].includes(saved.density)) state.density = saved.density;
        state.wrap = Boolean(saved.wrap);
        state.safeExport = saved.safeExport !== false;
      } catch {
        // 壊れた表示設定は無視して、初期値で表示する。
      }
    }

    function saveViewSettings() {
      if (!state.datasetStorageKey) return;
      try {
        localStorage.setItem(state.datasetStorageKey, JSON.stringify({
          visibleColumns: state.visibleColumns,
          columnOrder: state.columnOrder,
          columnWidths: state.columnWidths,
          freezeCount: state.freezeCount,
          density: state.density,
          wrap: state.wrap,
          safeExport: state.safeExport
        }));
      } catch {
        // 保存できなくてもビューア本体は利用できる。
      }
    }

    function visibleColumnIndexes() {
      return state.columnOrder.filter((columnIndex) => state.visibleColumns[columnIndex]);
    }

    function syncViewControls() {
      const visibleCount = visibleColumnIndexes().length;
      state.freezeCount = Math.min(state.freezeCount, visibleCount);
      elements.freezeCount.max = String(visibleCount);
      elements.freezeCount.value = String(state.freezeCount);
      elements.densitySelect.value = state.density;
      elements.wrapToggle.checked = state.wrap;
      document.body.classList.toggle("wrap-cells", state.wrap);
      const padding = state.density === "compact" ? "6px" : (state.density === "comfortable" ? "14px" : "10px");
      document.documentElement.style.setProperty("--row-padding", padding);
    }

    function buildColumnList() {
      elements.columnList.replaceChildren();
      state.columnOrder.forEach((columnIndex) => {
        const header = state.displayHeaders[columnIndex];
        const label = createElement("label", { className: "column-item" });
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.visibleColumns[columnIndex];
        checkbox.dataset.column = String(columnIndex);
        const text = createElement("span", { text: header });
        label.append(checkbox, text);
        elements.columnList.append(label);
      });
      filterColumnList();
    }

    function buildColumnOrderList() {
      const scrollTop = elements.columnOrderList.scrollTop;
      elements.columnOrderList.replaceChildren();
      state.columnOrder.forEach((columnIndex, position) => {
        const item = createElement("li", { className: "column-order-item" });
        const number = createElement("span", { className: "column-order-position", text: position + 1 });
        number.setAttribute("aria-hidden", "true");
        const name = createElement("span", {
          className: "column-order-name",
          text: `${state.displayHeaders[columnIndex]}${state.visibleColumns[columnIndex] ? "" : "（非表示）"}`
        });
        const actions = createElement("div", { className: "column-order-actions" });
        [-1, 1].forEach((direction) => {
          const button = createElement("button", {
            className: "button button-small",
            type: "button",
            text: direction < 0 ? "▲" : "▼"
          });
          button.dataset.moveColumn = String(columnIndex);
          button.dataset.direction = String(direction);
          button.disabled = direction < 0 ? position === 0 : position === state.columnOrder.length - 1;
          button.setAttribute("aria-label", `${state.displayHeaders[columnIndex]}を${direction < 0 ? "前" : "後ろ"}へ移動`);
          actions.append(button);
        });
        item.append(number, name, actions);
        elements.columnOrderList.append(item);
      });
      elements.columnOrderList.scrollTop = scrollTop;
    }

    function applyColumnOrder(order) {
      state.columnOrder = order;
      saveViewSettings();
      buildColumnList();
      renderHeader();
      renderBody();
    }

    function filterColumnList() {
      const query = elements.columnSearch.value.trim().toLocaleLowerCase("ja");
      elements.columnList.querySelectorAll(".column-item").forEach((item) => {
        item.hidden = query !== "" && !item.textContent.toLocaleLowerCase("ja").includes(query);
      });
    }

    function renderAll() {
      buildColumnList();
      renderHeader();
      applyFiltersAndRender(true);
      updateHiddenControls();
    }

    function renderHeader() {
      elements.tableColumns.replaceChildren();
      const selectionCol = createElement("col");
      selectionCol.style.width = "44px";
      elements.tableColumns.append(selectionCol);
      visibleColumnIndexes().forEach((columnIndex) => {
        const col = createElement("col");
        col.dataset.col = String(columnIndex);
        col.style.width = `${state.columnWidths[columnIndex]}px`;
        elements.tableColumns.append(col);
      });

      const headingRow = createElement("tr");
      const selectionHeader = createElement("th", { className: "selection-column" });
      selectionHeader.scope = "col";
      selectionHeader.dataset.uiColumn = "selection";
      const selectAll = createElement("input");
      selectAll.type = "checkbox";
      selectAll.id = "select-all-visible";
      selectAll.setAttribute("aria-label", "検索結果の行をすべて選択");
      selectionHeader.append(selectAll);
      headingRow.append(selectionHeader);

      visibleColumnIndexes().forEach((columnIndex) => {
        const th = createElement("th");
        th.scope = "col";
        th.dataset.col = String(columnIndex);
        th.draggable = true;
        th.title = "クリックで行を並べ替え / ドラッグで列を移動";
        const button = createElement("button", { className: "sort-button", type: "button" });
        button.dataset.sortColumn = String(columnIndex);
        const label = createElement("span", { text: state.displayHeaders[columnIndex] });
        const indicatorText = state.sortColumn === columnIndex
          ? (state.sortDirection === "asc" ? "▲" : "▼")
          : "↕";
        const indicator = createElement("span", { className: "sort-indicator", text: indicatorText });
        indicator.setAttribute("aria-hidden", "true");
        button.append(label, indicator);
        const resizeHandle = createElement("span", { className: "resize-handle" });
        resizeHandle.dataset.resizeColumn = String(columnIndex);
        resizeHandle.setAttribute("aria-hidden", "true");
        th.append(button, resizeHandle);
        headingRow.append(th);
      });
      elements.tableHead.replaceChildren(headingRow);

      if (state.filtersVisible) {
        const filterRow = createElement("tr", { className: "filter-row" });
        const emptyHeader = createElement("th", { className: "selection-column" });
        emptyHeader.dataset.uiColumn = "selection";
        filterRow.append(emptyHeader);
        visibleColumnIndexes().forEach((columnIndex) => {
          const th = createElement("th");
          th.dataset.col = String(columnIndex);
          const input = createElement("input");
          input.type = "search";
          input.value = state.columnFilters[columnIndex];
          input.placeholder = "絞り込み";
          input.dataset.filterColumn = String(columnIndex);
          input.setAttribute("aria-label", `${state.displayHeaders[columnIndex]}を絞り込み`);
          th.append(input);
          filterRow.append(th);
        });
        elements.tableHead.append(filterRow);
      }

      selectAll.addEventListener("change", () => {
        if (selectAll.checked) {
          state.viewRows.forEach((rowIndex) => state.selectedRows.add(rowIndex));
        } else {
          state.viewRows.forEach((rowIndex) => state.selectedRows.delete(rowIndex));
        }
        renderBody();
      });
    }

    function rowMatches(row) {
      const globalQuery = state.globalQuery;
      if (globalQuery && !row.some((value) => value.toLocaleLowerCase("ja").includes(globalQuery))) {
        return false;
      }
      for (let columnIndex = 0; columnIndex < state.columnFilters.length; columnIndex += 1) {
        const filter = state.columnFilters[columnIndex].trim().toLocaleLowerCase("ja");
        if (filter && !String(row[columnIndex] ?? "").toLocaleLowerCase("ja").includes(filter)) {
          return false;
        }
      }
      return true;
    }

    function compareRows(leftIndex, rightIndex) {
      if (state.sortColumn === null || state.sortDirection === "none") return leftIndex - rightIndex;
      const left = state.rows[leftIndex][state.sortColumn] ?? "";
      const right = state.rows[rightIndex][state.sortColumn] ?? "";
      const compared = collator.compare(left, right);
      if (compared === 0) return leftIndex - rightIndex;
      return state.sortDirection === "asc" ? compared : -compared;
    }

    function applyFiltersAndRender(resetLimit) {
      finishCellEdit();
      pendingEditRefresh = false;
      if (resetLimit) state.renderLimit = INITIAL_RENDER_COUNT;
      updateViewRows();
      renderBody();
    }

    function updateViewRows() {
      state.viewRows = state.rows
        .map((_, index) => index)
        .filter((index) => !state.hiddenRows.has(index) && rowMatches(state.rows[index]))
        .sort(compareRows);
    }

    function cellKey(rowIndex, columnIndex) {
      return `${rowIndex}:${columnIndex}`;
    }

    function sourceLineNumber(rowIndex) {
      return state.rowLines[rowIndex] ?? rowIndex + 2;
    }

    function renderBody() {
      finishCellEdit();
      if (pendingEditRefresh) {
        pendingEditRefresh = false;
        updateViewRows();
      }
      const fragment = document.createDocumentFragment();
      const visibleColumns = visibleColumnIndexes();
      const displayedRows = state.viewRows.slice(0, state.renderLimit);

      displayedRows.forEach((rowIndex) => {
        const tr = createElement("tr");
        tr.dataset.row = String(rowIndex);
        const selectionCell = createElement("td", { className: "selection-column" });
        selectionCell.dataset.uiColumn = "selection";
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = state.selectedRows.has(rowIndex);
        checkbox.dataset.selectRow = String(rowIndex);
        checkbox.setAttribute("aria-label", `CSV ${sourceLineNumber(rowIndex)} 行目を選択`);
        selectionCell.append(checkbox);
        tr.append(selectionCell);

        visibleColumns.forEach((columnIndex) => {
          const td = createElement("td");
          const key = cellKey(rowIndex, columnIndex);
          td.dataset.cell = key;
          td.dataset.row = String(rowIndex);
          td.dataset.col = String(columnIndex);
          td.tabIndex = 0;
          if (state.hiddenCells.has(key)) {
            td.classList.add("is-hidden-cell");
            td.setAttribute("aria-label", `${state.displayHeaders[columnIndex]}は非表示です`);
          } else {
            const value = state.rows[rowIndex][columnIndex] ?? "";
            td.textContent = value;
            td.title = value;
          }
          if (state.selectedCell === key) td.classList.add("is-selected");
          tr.append(td);
        });
        fragment.append(tr);
      });

      elements.tableBody.replaceChildren(fragment);
      elements.emptyResult.hidden = state.viewRows.length !== 0;
      elements.renderMoreButton.hidden = state.renderLimit >= state.viewRows.length;
      if (!elements.renderMoreButton.hidden) {
        const remaining = state.viewRows.length - state.renderLimit;
        elements.renderMoreButton.textContent = `さらに表示（残り ${remaining} 行）`;
      }
      elements.rowCount.textContent = `${state.viewRows.length} / ${state.rows.length} 行`;
      elements.hideRowsButton.disabled = state.selectedRows.size === 0 && state.selectedCell === null;
      elements.hideCellButton.disabled = state.selectedCell === null;

      const selectAll = document.getElementById("select-all-visible");
      if (selectAll) {
        const selectedInView = state.viewRows.filter((rowIndex) => state.selectedRows.has(rowIndex)).length;
        selectAll.checked = state.viewRows.length > 0 && selectedInView === state.viewRows.length;
        selectAll.indeterminate = selectedInView > 0 && selectedInView < state.viewRows.length;
      }
      updateSelectionStatus();
      requestAnimationFrame(updateStickyColumns);
    }

    function updateSelectionStatus() {
      if (cellEdit !== null) {
        elements.selectionStatus.textContent = `編集中: ${state.displayHeaders[cellEdit.columnIndex]} / Enterで確定・Escで取り消し・Alt+Enterで改行`;
      } else if (state.selectedCell !== null) {
        const [rowIndex, columnIndex] = state.selectedCell.split(":").map(Number);
        elements.selectionStatus.textContent = `選択中: CSV ${sourceLineNumber(rowIndex)} 行目 / ${state.displayHeaders[columnIndex]}`;
      } else if (state.selectedRows.size > 0) {
        elements.selectionStatus.textContent = `${state.selectedRows.size} 行を選択中です。`;
      } else {
        elements.selectionStatus.textContent = "クリックでセルを選択、ダブルクリックで編集できます。行は左端のチェックボックスで選択できます。";
      }
    }

    function clearStickyStyles() {
      elements.table.querySelectorAll(".sticky-column").forEach((cell) => {
        cell.classList.remove("sticky-column");
        cell.style.left = "";
      });
    }

    function updateStickyColumns() {
      clearStickyStyles();
      const selectionCells = elements.table.querySelectorAll('[data-ui-column="selection"]');
      selectionCells.forEach((cell) => {
        cell.classList.add("sticky-column");
        cell.style.left = "0px";
      });

      let left = 44;
      const fixedColumns = visibleColumnIndexes().slice(0, state.freezeCount);
      fixedColumns.forEach((columnIndex) => {
        const cells = elements.table.querySelectorAll(`[data-col="${columnIndex}"]`);
        cells.forEach((cell) => {
          cell.classList.add("sticky-column");
          cell.style.left = `${left}px`;
        });
        const col = elements.tableColumns.querySelector(`col[data-col="${columnIndex}"]`);
        left += col ? col.getBoundingClientRect().width : state.columnWidths[columnIndex];
      });
    }

    function updateHiddenControls() {
      const hiddenCount = state.hiddenRows.size + state.hiddenCells.size;
      elements.hiddenCount.textContent = String(hiddenCount);
      elements.openHiddenButton.disabled = hiddenCount === 0;
    }

    function buildHiddenList() {
      elements.hiddenList.replaceChildren();
      const entries = [];
      Array.from(state.hiddenRows).sort((left, right) => left - right).forEach((rowIndex) => {
        entries.push({ type: "row", rowIndex, text: `CSV ${sourceLineNumber(rowIndex)} 行目` });
      });
      Array.from(state.hiddenCells).forEach((key) => {
        const [rowIndex, columnIndex] = key.split(":").map(Number);
        entries.push({
          type: "cell",
          key,
          rowIndex,
          columnIndex,
          text: `CSV ${sourceLineNumber(rowIndex)} 行目 / ${state.displayHeaders[columnIndex]}`
        });
      });

      entries.forEach((entry) => {
        const item = createElement("div", { className: "hidden-item" });
        const type = createElement("strong", { text: entry.type === "row" ? "行" : "セル" });
        const label = createElement("span", { text: entry.text });
        const restoreButton = createElement("button", { className: "button button-small", text: "表示へ戻す", type: "button" });
        restoreButton.dataset.restoreType = entry.type;
        if (entry.type === "row") restoreButton.dataset.row = String(entry.rowIndex);
        if (entry.type === "cell") restoreButton.dataset.cell = entry.key;
        item.append(type, label, restoreButton);
        elements.hiddenList.append(item);
      });

      if (entries.length === 0) {
        elements.hiddenList.append(createElement("p", { className: "empty-result", text: "隠している行やセルはありません。" }));
      }
    }

    function restoreAllHidden() {
      state.hiddenRows.clear();
      state.hiddenCells.clear();
      updateHiddenControls();
      buildHiddenList();
      applyFiltersAndRender(true);
    }

    function reparseCurrentSource() {
      try {
        if (state.rawBytes) {
          const decoded = decodeBytes(state.rawBytes, elements.encodingSelect.value);
          parseText(decoded.text, { name: state.sourceName, encoding: decoded.encoding, isSample: false });
        } else if (state.rawText !== null) {
          parseText(state.rawText, {
            name: state.sourceName || "貼り付けデータ",
            encoding: "",
            isSample: state.isSample
          });
        }
      } catch (error) {
        handleLoadError(error, state.sourceName);
      }
    }

    async function loadFile(file) {
      if (!file) return;
      if (file.size > MAX_FILE_BYTES) {
        handleLoadError(
          new CsvLoadError(
            "ファイルが大きすぎます。",
            [`読み込み上限は ${Math.round(MAX_FILE_BYTES / 1024 / 1024)} MBです。`]
          ),
          file.name
        );
        return;
      }

      try {
        const buffer = await file.arrayBuffer();
        const bytes = new Uint8Array(buffer);
        const decoded = decodeBytes(bytes, elements.encodingSelect.value);
        state.sourceName = file.name;
        state.rawBytes = bytes;
        state.rawText = null;
        parseText(decoded.text, { name: file.name, encoding: decoded.encoding, isSample: false });
      } catch (error) {
        handleLoadError(error, file.name);
      } finally {
        elements.fileInput.value = "";
      }
    }

    function exportVisibleData() {
      const columns = visibleColumnIndexes();
      if (columns.length === 0) {
        showIssues("warning", "書き出せません", "表示中の列がありません。", ["「列を表示・非表示」から1列以上を表示してください。"]);
        return;
      }

      const outputRows = [];
      outputRows.push(columns.map((columnIndex) => state.headers[columnIndex]));
      state.viewRows.forEach((rowIndex) => {
        outputRows.push(columns.map((columnIndex) => (
          state.hiddenCells.has(cellKey(rowIndex, columnIndex)) ? "" : (state.rows[rowIndex][columnIndex] ?? "")
        )));
      });
      const csv = outputRows
        .map((row) => row.map((value) => escapeCsvValue(value, state.safeExport)).join(","))
        .join("\r\n");
      const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = createElement("a");
      const baseName = (state.sourceName || "data").replace(/\.(csv|tsv|txt)$/i, "").replace(/[\\/:*?"<>|]/g, "-");
      link.href = url;
      link.download = `${baseName}-表示中.csv`;
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    elements.openFileButton.addEventListener("click", () => elements.fileInput.click());
    elements.fileInput.addEventListener("change", () => loadFile(elements.fileInput.files[0]));
    elements.openPasteButton.addEventListener("click", () => {
      elements.pasteInput.value = "";
      elements.pasteDialog.showModal();
      elements.pasteInput.focus();
    });
    elements.loadPasteButton.addEventListener("click", () => {
      try {
        const text = elements.pasteInput.value;
        state.sourceName = "貼り付けデータ";
        state.rawBytes = null;
        state.rawText = text;
        parseText(text, { name: "貼り付けデータ", encoding: "", isSample: false });
        elements.pasteDialog.close();
      } catch (error) {
        elements.pasteDialog.close();
        handleLoadError(error, "貼り付けデータ");
      }
    });

    ["dragenter", "dragover"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.add("is-dragging");
      });
    });
    ["dragleave", "drop"].forEach((eventName) => {
      elements.dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        elements.dropZone.classList.remove("is-dragging");
      });
    });
    elements.dropZone.addEventListener("drop", (event) => {
      const files = event.dataTransfer?.files;
      if (files?.length) loadFile(files[0]);
    });

    elements.encodingSelect.addEventListener("change", reparseCurrentSource);
    elements.delimiterSelect.addEventListener("change", reparseCurrentSource);
    elements.closeIssueButton.addEventListener("click", hideIssues);

    elements.globalSearch.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.globalQuery = elements.globalSearch.value.trim().toLocaleLowerCase("ja");
        applyFiltersAndRender(true);
      }, 100);
    });

    elements.toggleFiltersButton.addEventListener("click", () => {
      state.filtersVisible = !state.filtersVisible;
      elements.toggleFiltersButton.setAttribute("aria-pressed", String(state.filtersVisible));
      renderHeader();
      renderBody();
    });

    elements.openColumnsButton.addEventListener("click", () => {
      elements.columnSearch.value = "";
      buildColumnList();
      elements.columnsDialog.showModal();
      elements.columnSearch.focus();
    });
    elements.openColumnOrderButton.addEventListener("click", () => {
      buildColumnOrderList();
      elements.columnOrderStatus.textContent = "非表示の列も含め、左からの列順を変更できます。";
      elements.columnOrderDialog.showModal();
    });
    elements.columnOrderList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-move-column]");
      if (!button || button.disabled) return;
      const columnIndex = Number(button.dataset.moveColumn);
      const direction = Number(button.dataset.direction);
      const position = state.columnOrder.indexOf(columnIndex);
      const targetColumn = state.columnOrder[position + direction];
      if (targetColumn === undefined) return;
      applyColumnOrder(reorderColumn(state.columnOrder, columnIndex, targetColumn, direction > 0));
      buildColumnOrderList();
      elements.columnOrderStatus.textContent = `${state.displayHeaders[columnIndex]}を ${position + direction + 1} 列目へ移動しました。`;
      const nextButton = elements.columnOrderList.querySelector(`button[data-move-column="${columnIndex}"][data-direction="${direction}"]`);
      const focusButton = nextButton.disabled
        ? elements.columnOrderList.querySelector(`button[data-move-column="${columnIndex}"]:not(:disabled)`)
        : nextButton;
      focusButton?.focus({ preventScroll: true });
      focusButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
    });
    elements.resetColumnOrderButton.addEventListener("click", () => {
      applyColumnOrder(normalizeColumnOrder(null, state.headers.length));
      buildColumnOrderList();
      elements.columnOrderStatus.textContent = "読み込んだCSVの列順に戻しました。";
    });
    elements.columnSearch.addEventListener("input", filterColumnList);
    elements.columnList.addEventListener("change", (event) => {
      const checkbox = event.target.closest("input[data-column]");
      if (!checkbox) return;
      const columnIndex = Number(checkbox.dataset.column);
      state.visibleColumns[columnIndex] = checkbox.checked;
      syncViewControls();
      saveViewSettings();
      renderHeader();
      renderBody();
    });
    elements.showAllColumnsButton.addEventListener("click", () => {
      state.visibleColumns = state.visibleColumns.map(() => true);
      syncViewControls();
      saveViewSettings();
      buildColumnList();
      renderHeader();
      renderBody();
    });
    elements.hideAllColumnsButton.addEventListener("click", () => {
      state.visibleColumns = state.visibleColumns.map(() => false);
      syncViewControls();
      saveViewSettings();
      buildColumnList();
      renderHeader();
      renderBody();
    });

    elements.tableHead.addEventListener("click", (event) => {
      if (performance.now() < suppressSortUntil) return;
      const button = event.target.closest("button[data-sort-column]");
      if (!button) return;
      const columnIndex = Number(button.dataset.sortColumn);
      if (state.sortColumn !== columnIndex) {
        state.sortColumn = columnIndex;
        state.sortDirection = "asc";
      } else if (state.sortDirection === "asc") {
        state.sortDirection = "desc";
      } else if (state.sortDirection === "desc") {
        state.sortColumn = null;
        state.sortDirection = "none";
      }
      renderHeader();
      applyFiltersAndRender(true);
    });
    elements.tableHead.addEventListener("input", (event) => {
      const input = event.target.closest("input[data-filter-column]");
      if (!input) return;
      const columnIndex = Number(input.dataset.filterColumn);
      state.columnFilters[columnIndex] = input.value;
      applyFiltersAndRender(true);
    });

    function clearColumnDropMarkers() {
      elements.tableHead.querySelectorAll(".drop-before, .drop-after").forEach((header) => {
        header.classList.remove("drop-before", "drop-after");
      });
    }

    function finishColumnDrag() {
      draggedColumn = null;
      suppressSortUntil = performance.now() + 250;
      clearColumnDropMarkers();
      elements.tableHead.querySelectorAll(".is-dragging-column").forEach((header) => {
        header.classList.remove("is-dragging-column");
      });
    }

    elements.tableHead.addEventListener("dragstart", (event) => {
      const header = event.target.closest('th[draggable="true"]');
      if (!header || event.target.closest(".resize-handle")) {
        event.preventDefault();
        return;
      }
      draggedColumn = Number(header.dataset.col);
      suppressSortUntil = Infinity;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(draggedColumn));
      header.classList.add("is-dragging-column");
    });
    elements.tableHead.addEventListener("dragover", (event) => {
      if (draggedColumn === null) return;
      const header = event.target.closest('th[draggable="true"]');
      clearColumnDropMarkers();
      if (!header) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      if (Number(header.dataset.col) === draggedColumn) return;
      const bounds = header.getBoundingClientRect();
      header.classList.add(event.clientX < bounds.left + bounds.width / 2 ? "drop-before" : "drop-after");
    });
    elements.tableHead.addEventListener("dragleave", (event) => {
      if (!elements.tableHead.contains(event.relatedTarget)) clearColumnDropMarkers();
    });
    elements.tableHead.addEventListener("drop", (event) => {
      if (draggedColumn === null) return;
      event.preventDefault();
      const header = event.target.closest('th[draggable="true"]');
      const sourceColumn = draggedColumn;
      finishColumnDrag();
      if (!header) return;
      const bounds = header.getBoundingClientRect();
      const targetColumn = Number(header.dataset.col);
      const after = event.clientX >= bounds.left + bounds.width / 2;
      applyColumnOrder(reorderColumn(state.columnOrder, sourceColumn, targetColumn, after));
    });
    elements.tableHead.addEventListener("dragend", finishColumnDrag);

    elements.tableHead.addEventListener("pointerdown", (event) => {
      const handle = event.target.closest("[data-resize-column]");
      if (!handle) return;
      event.preventDefault();
      event.stopPropagation();
      const columnIndex = Number(handle.dataset.resizeColumn);
      const startX = event.clientX;
      const startWidth = state.columnWidths[columnIndex];
      handle.classList.add("is-resizing");
      handle.setPointerCapture(event.pointerId);

      const move = (moveEvent) => {
        const width = Math.min(600, Math.max(80, startWidth + moveEvent.clientX - startX));
        state.columnWidths[columnIndex] = width;
        const col = elements.tableColumns.querySelector(`col[data-col="${columnIndex}"]`);
        if (col) col.style.width = `${width}px`;
        updateStickyColumns();
      };
      const finish = () => {
        handle.classList.remove("is-resizing");
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", finish);
        handle.removeEventListener("pointercancel", finish);
        saveViewSettings();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", finish);
      handle.addEventListener("pointercancel", finish);
    });

    function selectCell(cell) {
      if (!cell) return;
      state.selectedCell = cell.dataset.cell;
      elements.tableBody.querySelectorAll("td.is-selected").forEach((selected) => selected.classList.remove("is-selected"));
      cell.classList.add("is-selected");
      elements.hideCellButton.disabled = false;
      elements.hideRowsButton.disabled = false;
      updateSelectionStatus();
    }

    function beginCellEdit(cell) {
      if (!cell || state.hiddenCells.has(cell.dataset.cell) || cellEdit?.cell === cell) return;
      finishCellEdit();
      selectCell(cell);
      const rowIndex = Number(cell.dataset.row);
      const columnIndex = Number(cell.dataset.col);
      cellEdit = {
        cell, rowIndex, columnIndex,
        originalValue: state.rows[rowIndex][columnIndex],
        lastValue: state.rows[rowIndex][columnIndex],
        composing: false,
        history: new EditHistory(),
        beforeSelection: null,
        lastInputType: "",
        lastInputAt: 0
      };
      cell.contentEditable = "plaintext-only";
      cell.spellcheck = false;
      cell.classList.add("is-editing");
      cell.removeAttribute("title");
      cell.setAttribute("role", "textbox");
      cell.setAttribute("aria-label", `${state.displayHeaders[columnIndex]}を編集`);
      cell.setAttribute("aria-multiline", "true");
      cell.focus({ preventScroll: true });
      const range = document.createRange();
      range.selectNodeContents(cell);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      updateSelectionStatus();
      updateHistoryButtons();
    }

    function finishCellEdit(commit = true) {
      if (cellEdit === null) return;
      const { cell, rowIndex, columnIndex, originalValue } = cellEdit;
      cellEdit = null;
      const value = commit ? cell.textContent.replace(/\r\n?/g, "\n") : originalValue;
      if (commit && value !== originalValue) {
        editHistory.record({ rowIndex, columnIndex, before: originalValue, after: value });
        state.rows[rowIndex][columnIndex] = value;
        pendingEditRefresh = true;
      }
      cell.removeAttribute("contenteditable");
      cell.removeAttribute("role");
      cell.removeAttribute("aria-label");
      cell.removeAttribute("aria-multiline");
      cell.classList.remove("is-editing");
      cell.textContent = value;
      cell.title = value;
      updateSelectionStatus();
      updateHistoryButtons();
    }

    function updateHistoryButtons() {
      const history = cellEdit?.history ?? editHistory;
      elements.undoButton.disabled = Boolean(cellEdit?.composing) || !history.canUndo;
      elements.redoButton.disabled = Boolean(cellEdit?.composing) || !history.canRedo;
    }

    function editorSelection() {
      const selection = window.getSelection();
      const cell = cellEdit.cell;
      if (!selection?.anchorNode || !cell.contains(selection.anchorNode) || !cell.contains(selection.focusNode)) {
        return { anchor: cell.textContent.length, focus: cell.textContent.length };
      }
      const offset = (node, position) => {
        const range = document.createRange();
        range.selectNodeContents(cell);
        range.setEnd(node, position);
        return range.toString().length;
      };
      return {
        anchor: offset(selection.anchorNode, selection.anchorOffset),
        focus: offset(selection.focusNode, selection.focusOffset)
      };
    }

    function recordEditorInput(inputType) {
      if (!cellEdit || cellEdit.composing) return;
      const value = cellEdit.cell.textContent.replace(/\r\n?/g, "\n");
      if (value === cellEdit.lastValue) return;
      const afterSelection = editorSelection();
      const beforeSelection = cellEdit.beforeSelection ?? afterSelection;
      const previous = cellEdit.history.undoStack.at(-1);
      const now = performance.now();
      const merge = ["insertText", "deleteContentBackward", "deleteContentForward"].includes(inputType) &&
        inputType === cellEdit.lastInputType && now - cellEdit.lastInputAt < 750 &&
        beforeSelection.anchor === beforeSelection.focus && previous?.afterSelection?.focus === beforeSelection.focus;
      cellEdit.history.record({
        before: cellEdit.lastValue, after: value, beforeSelection, afterSelection
      }, merge);
      cellEdit.lastValue = value;
      cellEdit.lastInputType = inputType;
      cellEdit.lastInputAt = now;
      cellEdit.beforeSelection = null;
      updateHistoryButtons();
    }

    function applyEditHistory(direction) {
      if (cellEdit) {
        if (cellEdit.composing) return;
        const change = cellEdit.history[direction]();
        if (!change) return;
        const value = direction === "undo" ? change.before : change.after;
        const caret = direction === "undo" ? change.beforeSelection : change.afterSelection;
        cellEdit.cell.textContent = value;
        cellEdit.lastValue = value;
        cellEdit.beforeSelection = null;
        cellEdit.lastInputType = "";
        cellEdit.lastInputAt = 0;
        cellEdit.cell.focus({ preventScroll: true });
        const node = cellEdit.cell.firstChild ?? cellEdit.cell;
        window.getSelection()?.setBaseAndExtent(node, Math.min(caret.anchor, value.length), node, Math.min(caret.focus, value.length));
      } else {
        const change = editHistory[direction]();
        if (!change) return;
        state.rows[change.rowIndex][change.columnIndex] = direction === "undo" ? change.before : change.after;
        applyFiltersAndRender(false);
        focusCell(cellKey(change.rowIndex, change.columnIndex));
        elements.selectionStatus.textContent = `${direction === "undo" ? "元に戻しました" : "やり直しました"}: CSV ${sourceLineNumber(change.rowIndex)} 行目 / ${state.displayHeaders[change.columnIndex]}`;
      }
      updateHistoryButtons();
    }

    function focusCell(key) {
      const cell = elements.tableBody.querySelector(`td[data-cell="${key}"]`);
      if (cell) {
        selectCell(cell);
        cell.focus({ preventScroll: true });
      } else {
        elements.tableRegion.focus({ preventScroll: true });
      }
    }

    function scheduleEditRefresh() {
      clearTimeout(editRefreshTimer);
      if (!pendingEditRefresh || pointerIsDown || cellEdit !== null) return;
      // ポインター操作ではクリックの処理が終わるまで、操作対象のDOMを作り直さない。
      editRefreshTimer = setTimeout(() => {
        if (!pendingEditRefresh || pointerIsDown || cellEdit !== null) return;
        const focused = document.activeElement;
        const focusedCell = focused?.dataset.cell;
        const focusedRow = focused?.dataset.selectRow;
        applyFiltersAndRender(false);
        if (focusedCell !== undefined) focusCell(focusedCell);
        else if (focusedRow !== undefined) {
          elements.tableBody.querySelector(`input[data-select-row="${focusedRow}"]`)?.focus({ preventScroll: true });
        }
      }, 0);
    }

    function insertCellText(text) {
      if (cellEdit === null) return;
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!cellEdit.cell.contains(range.commonAncestorContainer)) return;
      cellEdit.beforeSelection = editorSelection();
      // 貼り付け内容はHTMLとして解釈せず、必ずテキストノードで挿入する。
      const node = document.createTextNode(text.replace(/\r\n?/g, "\n"));
      range.deleteContents();
      range.insertNode(node);
      range.setStartAfter(node);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      recordEditorInput("insertFromPaste");
    }

    document.addEventListener("pointerdown", () => { pointerIsDown = true; }, true);
    ["pointerup", "pointercancel"].forEach((eventName) => {
      document.addEventListener(eventName, () => {
        pointerIsDown = false;
        scheduleEditRefresh();
      }, true);
    });
    window.addEventListener("blur", () => {
      pointerIsDown = false;
      finishCellEdit();
      scheduleEditRefresh();
    });

    elements.tableBody.addEventListener("dblclick", (event) => {
      const cell = event.target.closest("td[data-cell]");
      if (!cell || cellEdit?.cell === cell) return;
      event.preventDefault();
      beginCellEdit(cell);
    });
    elements.tableBody.addEventListener("focusout", (event) => {
      if (cellEdit?.cell !== event.target) return;
      finishCellEdit();
      scheduleEditRefresh();
    });
    elements.tableBody.addEventListener("compositionstart", () => {
      if (cellEdit) {
        cellEdit.beforeSelection = editorSelection();
        cellEdit.composing = true;
        updateHistoryButtons();
      }
    });
    elements.tableBody.addEventListener("compositionend", () => {
      if (cellEdit) {
        cellEdit.composing = false;
        recordEditorInput("insertCompositionText");
        updateHistoryButtons();
      }
    });
    elements.tableBody.addEventListener("paste", (event) => {
      if (cellEdit?.cell !== event.target.closest("td[data-cell]")) return;
      event.preventDefault();
      insertCellText(event.clipboardData?.getData("text/plain") ?? "");
    });
    elements.tableBody.addEventListener("drop", (event) => {
      if (cellEdit !== null) event.preventDefault();
    });
    elements.tableBody.addEventListener("beforeinput", (event) => {
      if (cellEdit === null) return;
      if (event.inputType === "historyUndo" || event.inputType === "historyRedo") {
        event.preventDefault();
        applyEditHistory(event.inputType === "historyUndo" ? "undo" : "redo");
        return;
      }
      if (event.inputType.startsWith("format") || event.inputType === "insertFromDrop") event.preventDefault();
      if (!cellEdit.composing) cellEdit.beforeSelection = editorSelection();
    });
    elements.tableBody.addEventListener("input", (event) => {
      recordEditorInput(event.inputType);
    });

    [[elements.undoButton, "undo"], [elements.redoButton, "redo"]].forEach(([button, direction]) => {
      button.addEventListener("pointerdown", (event) => {
        // 編集中でもフォーカスをセルに保ち、未確定の入力履歴を操作する。
        event.preventDefault();
      });
      button.addEventListener("click", () => applyEditHistory(direction));
    });
    document.addEventListener("keydown", (event) => {
      if (elements.viewer.hidden || event.defaultPrevented || event.isComposing || event.keyCode === 229 ||
          event.altKey || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      const direction = key === "y" || (key === "z" && event.shiftKey) ? "redo" : (key === "z" ? "undo" : null);
      if (!direction) return;
      const target = event.target;
      if (target.closest("input, textarea, select, [contenteditable]") && cellEdit?.cell !== target.closest("td[data-cell]")) return;
      event.preventDefault();
      applyEditHistory(direction);
    });

    elements.tableBody.addEventListener("click", (event) => {
      const checkbox = event.target.closest("input[data-select-row]");
      if (checkbox) {
        const rowIndex = Number(checkbox.dataset.selectRow);
        if (checkbox.checked) state.selectedRows.add(rowIndex);
        else state.selectedRows.delete(rowIndex);
        elements.hideRowsButton.disabled = state.selectedRows.size === 0 && state.selectedCell === null;
        updateSelectionStatus();
        return;
      }
      selectCell(event.target.closest("td[data-cell]"));
    });
    elements.tableBody.addEventListener("keydown", (event) => {
      const cell = event.target.closest("td[data-cell]");
      if (!cell) return;
      if (cellEdit?.cell === cell) {
        if (event.isComposing || cellEdit.composing || event.keyCode === 229) return;
        if (event.key === "Enter" && event.altKey) {
          event.preventDefault();
          insertCellText("\n");
        } else if (["Enter", "Escape", "Tab"].includes(event.key)) {
          event.preventDefault();
          let targetKey = cell.dataset.cell;
          if (event.key === "Tab") {
            const columns = visibleColumnIndexes();
            const rowPosition = state.viewRows.indexOf(cellEdit.rowIndex);
            const position = rowPosition * columns.length + columns.indexOf(cellEdit.columnIndex) + (event.shiftKey ? -1 : 1);
            if (position >= 0 && position < Math.min(state.renderLimit, state.viewRows.length) * columns.length) {
              targetKey = cellKey(state.viewRows[Math.floor(position / columns.length)], columns[position % columns.length]);
            }
          }
          finishCellEdit(event.key !== "Escape");
          applyFiltersAndRender(false);
          focusCell(targetKey);
        }
        return;
      }
      if (event.key === "F2") {
        event.preventDefault();
        beginCellEdit(cell);
        return;
      }
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      selectCell(cell);
    });

    elements.hideCellButton.addEventListener("click", () => {
      if (state.selectedCell === null) return;
      state.hiddenCells.add(state.selectedCell);
      state.selectedCell = null;
      updateHiddenControls();
      renderBody();
    });
    elements.hideRowsButton.addEventListener("click", () => {
      if (state.selectedRows.size === 0 && state.selectedCell !== null) {
        state.selectedRows.add(Number(state.selectedCell.split(":")[0]));
      }
      state.selectedRows.forEach((rowIndex) => state.hiddenRows.add(rowIndex));
      state.selectedRows.clear();
      state.selectedCell = null;
      updateHiddenControls();
      applyFiltersAndRender(true);
    });
    elements.openHiddenButton.addEventListener("click", () => {
      buildHiddenList();
      elements.hiddenDialog.showModal();
    });
    elements.hiddenList.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-restore-type]");
      if (!button) return;
      if (button.dataset.restoreType === "row") state.hiddenRows.delete(Number(button.dataset.row));
      if (button.dataset.restoreType === "cell") state.hiddenCells.delete(button.dataset.cell);
      updateHiddenControls();
      buildHiddenList();
      applyFiltersAndRender(true);
    });
    elements.restoreAllButton.addEventListener("click", restoreAllHidden);

    elements.freezeCount.addEventListener("change", () => {
      const max = visibleColumnIndexes().length;
      state.freezeCount = Math.min(max, Math.max(0, Number.parseInt(elements.freezeCount.value, 10) || 0));
      elements.freezeCount.value = String(state.freezeCount);
      saveViewSettings();
      updateStickyColumns();
    });
    elements.densitySelect.addEventListener("change", () => {
      state.density = elements.densitySelect.value;
      syncViewControls();
      saveViewSettings();
      requestAnimationFrame(updateStickyColumns);
    });
    elements.wrapToggle.addEventListener("change", () => {
      state.wrap = elements.wrapToggle.checked;
      syncViewControls();
      saveViewSettings();
      requestAnimationFrame(updateStickyColumns);
    });
    elements.resetViewButton.addEventListener("click", () => {
      state.visibleColumns = state.headers.map(() => true);
      state.columnOrder = normalizeColumnOrder(null, state.headers.length);
      state.columnWidths = state.headers.map(() => 160);
      state.columnFilters = state.headers.map(() => "");
      state.globalQuery = "";
      state.sortColumn = null;
      state.sortDirection = "none";
      state.freezeCount = Math.min(1, state.headers.length);
      state.density = "normal";
      state.wrap = false;
      state.safeExport = true;
      elements.globalSearch.value = "";
      syncViewControls();
      saveViewSettings();
      renderAll();
    });
    elements.exportButton.addEventListener("click", () => {
      const columnCount = visibleColumnIndexes().length;
      if (columnCount === 0) {
        showIssues("warning", "書き出せません", "表示中の列がありません。", ["「列を表示・非表示」から1列以上を表示してください。"]);
        return;
      }
      elements.exportSummary.textContent = `表示中の ${state.viewRows.length} 行・${columnCount} 列を書き出します。`;
      elements.exportSafeToggle.checked = state.safeExport;
      elements.exportDialog.showModal();
    });
    elements.confirmExportButton.addEventListener("click", () => {
      state.safeExport = elements.exportSafeToggle.checked;
      saveViewSettings();
      exportVisibleData();
      elements.exportDialog.close();
    });
    elements.renderMoreButton.addEventListener("click", () => {
      state.renderLimit += RENDER_BATCH_COUNT;
      renderBody();
    });
    window.addEventListener("resize", () => requestAnimationFrame(updateStickyColumns));

    state.rawText = SAMPLE_CSV;
    state.rawBytes = null;
    try {
      parseText(SAMPLE_CSV, { name: "架空サンプル.csv", encoding: "utf-8", isSample: true });
    } catch (error) {
      handleLoadError(error, "架空サンプル.csv");
    }
  });
})();
