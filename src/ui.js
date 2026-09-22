// 界面业务：筛选、余量统计面板、危废移交/签收/复核弹窗与事件绑定。

import {
  REPAIR_STATUSES,
  SELECTABLE_STATUSES,
  WASTE_CATEGORIES,
  HISTORY_LABELS,
  storageStats,
  prepareHandover,
  receiveHandover,
  releaseHandover,
  activeHandover
} from "./rules.js";
import { loadState, saveState } from "./storage.js";

const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

const HANDOVER_STATUS_LABELS = {
  waiting: "待签收",
  review: "异常复核·已冻结",
  archived: "已归档"
};

let state = loadState();
const app = document.querySelector("#app");

export function startApp() {
  render();
}

function render() {
  const repairs = filteredRepairs();
  const unfinished = state.repairs.filter((repair) => repair.status !== "done");
  const totalCost = unfinished.reduce((total, repair) => total + Number(repair.cost || 0), 0);
  const countBy = (status) => state.repairs.filter((repair) => repair.status === status).length;

  app.innerHTML = `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维护台 · 危废清运闭环</p>
          <h1>家庭维修事项</h1>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成</span><strong>${unfinished.length}</strong></div>
          <div class="stat"><span>处理中</span><strong>${countBy("doing")}</strong></div>
          <div class="stat"><span>待签收</span><strong>${countBy("waiting")}</strong></div>
          <div class="stat review-stat"><span>异常复核</span><strong>${countBy("review")}</strong></div>
          <div class="stat"><span>预计费用</span><strong>¥${totalCost}</strong></div>
        </section>
      </header>

      <section class="layout">
        <aside class="side">
          <section class="panel">
            <h2>新增维修事项</h2>
            <form class="form" id="repair-form">
              <label>位置<input name="location" required placeholder="例如卫生间"></label>
              <label>问题描述<textarea name="title" required placeholder="例如更换顶灯"></textarea></label>
              <label>优先级<select name="priority">${renderPriorityOptions("medium")}</select></label>
              <label>预计费用<input name="cost" type="number" min="0" step="1" value="0"></label>
              <label>处理状态<select name="status">${renderSelectableStatusOptions("todo")}</select></label>
              <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址"></label>
              <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项"></textarea></label>
              <button class="primary" type="submit">保存事项</button>
            </form>
          </section>
          ${renderStoragePanel()}
        </aside>

        <section>
          <div class="toolbar">
            ${Object.entries(REPAIR_STATUSES)
              .map(
                ([value, label]) =>
                  `<button class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
              )
              .join("")}
          </div>
          <div class="repairs">
            ${repairs.length ? repairs.map(renderRepair).join("") : `<div class="empty">当前筛选下没有维修事项</div>`}
          </div>
        </section>
      </section>
    </main>
  `;

  bindEvents();
}

// —— 暂存点余量统计面板（与存档同源，刷新保留）——
function renderStoragePanel() {
  const stats = storageStats(state);
  return `
    <section class="panel storage-panel">
      <h2>危废暂存点余量</h2>
      ${stats
        .map(
          (point) => `
        <div class="point">
          <h3>${escapeHtml(point.name)}</h3>
          <ul class="cap-list">
            ${point.rows
              .map(
                (row) => `
              <li class="cap ${row.level}">
                <span>${row.label}</span>
                <span class="cap-num">
                  ${
                    row.level === "none"
                      ? "不接收"
                      : `余 ${row.remaining}/${row.capacity} ${row.unit}`
                  }
                </span>
              </li>`
              )
              .join("")}
          </ul>
        </div>`
        )
        .join("")}
    </section>`;
}

function renderRepair(repair) {
  return `
    <article class="repair">
      <div class="photo">${repair.photo ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">` : "未添加照片"}</div>
      <div class="content">
        <div class="row">
          <h3>${escapeHtml(repair.location)}</h3>
          <span class="priority ${repair.priority}">${priorities[repair.priority] || repair.priority}</span>
          <span class="status ${repair.status}">${REPAIR_STATUSES[repair.status] || repair.status}</span>
        </div>
        <p>${escapeHtml(repair.title)}</p>
        <div class="row">
          <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
          <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
        </div>
        ${renderHandover(repair)}
        <div class="actions">
          ${
            repair.status === "todo" || repair.status === "doing"
              ? `<select data-status="${repair.id}">${renderSelectableStatusOptions(repair.status)}</select>
                 <button class="primary small" data-action="transfer" data-id="${repair.id}">完工移交登记</button>
                 <button class="ghost" data-delete="${repair.id}">删除</button>`
              : repair.status === "waiting"
                ? `<button class="primary small" data-action="receive" data-id="${repair.id}">清运签收</button>
                   <span class="chip lock">交接进行中，不可删除</span>`
                : repair.status === "review"
                  ? `<button class="danger small" data-action="resolve" data-id="${repair.id}">补处置说明</button>
                     <span class="chip lock">异常复核中，已冻结归档</span>`
                  : `<span class="chip lock">已归档事项不可删除或改写</span>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderHandover(repair) {
  const handover = repair.handover ?? activeHandover(repair);
  if (!handover) return "";

  const receiptBlock = handover.receipt
    ? `
    <div class="h-receipt ${handover.receipt.voucherMissing ? "bad" : ""}">
      <strong>签收记录：</strong>${escapeHtml(
        formatTime(handover.receipt.at)
      )}，凭证：${handover.receipt.voucher ? escapeHtml(handover.receipt.voucher) : "<em>缺失</em>"}
      ${
        handover.receipt.discrepancies.length
          ? `<ul class="h-diff">${handover.receipt.discrepancies
              .map((item) => `<li>${escapeHtml(item.message)}</li>`)
              .join("")}</ul>`
          : handover.receipt.matched
            ? "，数量与移交一致"
            : ""
      }
    </div>`
    : "";

  const resolutionBlock = handover.resolution
    ? `
    <div class="h-resolution">
      <strong>处置说明（仅释放本事项，历史不改）：</strong>${escapeHtml(
        handover.resolution.explanation
      )} · ${escapeHtml(formatTime(handover.resolution.at))}
    </div>`
    : "";

  return `
    <section class="handover h-${handover.status}">
      <div class="row h-head">
        <span class="h-badge">${HANDOVER_STATUS_LABELS[handover.status]}</span>
        <span class="chip">暂存点：${escapeHtml(handover.pointName)}</span>
        <span class="chip">登记：${escapeHtml(formatTime(handover.createdAt))}</span>
      </div>
      <ul class="h-items">
        ${handover.items
          .map(
            (item) =>
              `<li>${WASTE_CATEGORIES[item.category].label} <strong>${item.quantity}${WASTE_CATEGORIES[item.category].unit}</strong></li>`
          )
          .join("")}
      </ul>
      ${receiptBlock}
      ${resolutionBlock}
      <details class="h-history">
        <summary>交接流水（只追加，历史不改写）</summary>
        <ol>
          ${handover.history
            .map(
              (entry) =>
                `<li><span class="chip">${HISTORY_LABELS[entry.action] || entry.action}</span> ${escapeHtml(
                  formatTime(entry.at)
                )} — ${escapeHtml(entry.detail)}</li>`
            )
            .join("")}
        </ol>
      </details>
    </section>`;
}

function renderSelectableStatusOptions(selected) {
  return SELECTABLE_STATUSES.map(
    (value) =>
      `<option value="${value}" ${selected === value ? "selected" : ""}>${REPAIR_STATUSES[value]}</option>`
  ).join("");
}

function renderPriorityOptions(selected) {
  return Object.entries(priorities)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function categoryOptions(selected = "") {
  return Object.entries(WASTE_CATEGORIES)
    .map(
      ([value, meta]) =>
        `<option value="${value}" ${selected === value ? "selected" : ""}>${meta.label}（${meta.unit}）</option>`
    )
    .join("");
}

// —— 事件 ——
function bindEvents() {
  document.querySelector("#repair-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.target));
    state.repairs.unshift({
      id: crypto.randomUUID(),
      location: data.location.trim(),
      title: data.title.trim(),
      priority: data.priority,
      cost: Number(data.cost || 0),
      status: data.status,
      photo: data.photo.trim(),
      note: data.note.trim(),
      handover: null
    });
    saveState(state);
    render();
  });

  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.filter = button.dataset.filter;
      saveState(state);
      render();
    });
  });

  document.querySelectorAll("[data-status]").forEach((select) => {
    select.addEventListener("change", () => {
      const repair = state.repairs.find((item) => item.id === select.dataset.status);
      if (!repair) return;
      if (!SELECTABLE_STATUSES.includes(select.value)) return;
      repair.status = select.value;
      saveState(state);
      render();
    });
  });

  document.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("click", () => {
      const repair = state.repairs.find((item) => item.id === button.dataset.delete);
      if (!repair) return;
      if (!window.confirm(`确认删除「${repair.location} · ${repair.title}」？`)) return;
      state.repairs = state.repairs.filter((item) => item.id !== repair.id);
      saveState(state);
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const repair = state.repairs.find((item) => item.id === button.dataset.id);
      if (!repair) return;
      if (button.dataset.action === "transfer") openTransferModal(repair);
      if (button.dataset.action === "receive") openReceiveModal(repair);
      if (button.dataset.action === "resolve") openResolveModal(repair);
    });
  });
}

function filteredRepairs() {
  if (state.filter === "all") return state.repairs;
  return state.repairs.filter((repair) => repair.status === state.filter);
}

// —— 弹窗：完工移交登记 ——
function openTransferModal(repair) {
  const modal = openModal({
    title: `完工移交登记 · ${repair.location}`,
    body: `
      <p class="modal-tip">仅登记废电池、油漆桶等<strong>危险废物</strong>；普通垃圾不属于危废，不得入账。</p>
      <label>暂存点
        <select name="pointId">
          <option value="">请选择暂存点</option>
          ${state.storage.points
            .map((point) => `<option value="${point.id}">${escapeHtml(point.name)}</option>`)
            .join("")}
        </select>
      </label>
      <div class="hw-rows" data-rows>
        <div class="hw-row" data-hw-row>
          <select name="category">${categoryOptions("battery")}</select>
          <input name="quantity" type="number" min="0" step="any" placeholder="数量">
          <button type="button" class="ghost small" data-remove-row>移除</button>
        </div>
      </div>
      <button type="button" class="ghost small" data-add-row>+ 增加危废类别</button>
      <div class="cap-hint" data-hint></div>
      <div class="form-errors" data-errors hidden></div>
      <div class="modal-actions">
        <button type="button" class="primary" data-submit>登记移交并转待签收</button>
        <button type="button" class="ghost" data-direct-done>本次无危废，直接完工</button>
      </div>`
  });

  const root = modal.element;
  const pointSelect = root.querySelector("[name='pointId']");
  const rowsBox = root.querySelector("[data-rows]");
  const hint = root.querySelector("[data-hint]");
  const errorsBox = root.querySelector("[data-errors]");

  const refreshHint = () => {
    const stats = storageStats(state);
    const point = stats.find((item) => item.id === pointSelect.value);
    if (!point) {
      hint.innerHTML = `<p class="modal-tip">选择暂存点后显示各类别余量；余量不足时整次移交将被拒绝，事项保持处理中。</p>`;
      return;
    }
    hint.innerHTML = `
      <ul class="cap-list compact">
        ${point.rows
          .filter((row) => row.level !== "none")
          .map(
            (row) =>
              `<li class="cap ${row.level}"><span>${row.label}</span><span class="cap-num">余 ${row.remaining}/${row.capacity} ${row.unit}</span></li>`
          )
          .join("")}
      </ul>`;
  };

  const gatherRows = () =>
    [...rowsBox.querySelectorAll("[data-hw-row]")].map((row) => ({
      category: row.querySelector("[name='category']").value,
      quantity: row.querySelector("[name='quantity']").value
    }));

  pointSelect.addEventListener("change", refreshHint);
  rowsBox.addEventListener("input", refreshHint);
  rowsBox.addEventListener("click", (event) => {
    if (event.target.matches("[data-remove-row]") && rowsBox.children.length > 1) {
      event.target.closest("[data-hw-row]").remove();
      refreshHint();
    }
  });
  root.querySelector("[data-add-row]").addEventListener("click", () => {
    const div = document.createElement("div");
    div.className = "hw-row";
    div.dataset.hwRow = "";
    div.innerHTML = `
      <select name="category">${categoryOptions()}</select>
      <input name="quantity" type="number" min="0" step="any" placeholder="数量">
      <button type="button" class="ghost small" data-remove-row>移除</button>`;
    rowsBox.appendChild(div);
    refreshHint();
  });

  root.querySelector("[data-direct-done]").addEventListener("click", () => {
    if (!window.confirm("确认本次维修未产生危废、直接完工归档？普通垃圾无需登记。")) return;
    repair.status = "done";
    repair.handover = null;
    saveState(state);
    modal.close();
    render();
  });

  root.querySelector("[data-submit]").addEventListener("click", () => {
    const result = prepareHandover(state, repair, {
      pointId: pointSelect.value,
      rows: gatherRows()
    });
    if (!result.ok) {
      showErrors(errorsBox, result.errors.map((error) => error.message));
      return;
    }
    repair.handover = result.handover;
    repair.status = "waiting";
    saveState(state);
    modal.close();
    render();
  });

  refreshHint();
}

// —— 弹窗：清运签收 ——
function openReceiveModal(repair) {
  const handover = repair.handover;
  const modal = openModal({
    title: `清运签收 · ${repair.location}`,
    body: `
      <p class="modal-tip">暂存点：${escapeHtml(handover.pointName)}。签收数量必须与移交一致，并填写清运凭证；缺凭证或数量不符将转入异常复核并冻结归档。</p>
      <div class="hw-rows" data-rows>
        ${handover.items
          .map(
            (item) => `
          <div class="hw-row" data-hw-row>
            <span class="hw-fixed">${WASTE_CATEGORIES[item.category].label}（移交 ${item.quantity}${WASTE_CATEGORIES[item.category].unit}）</span>
            <input name="quantity" type="number" min="0" step="any" value="${item.quantity}" placeholder="实收数量">
          </div>`
          )
          .join("")}
      </div>
      <label>清运凭证（联单号 / 照片链接）
        <input name="voucher" placeholder="缺凭证将转入异常复核并冻结归档">
      </label>
      <div class="form-errors" data-errors hidden></div>
      <div class="modal-actions">
        <button type="button" class="primary" data-submit>确认签收</button>
      </div>`
  });

  const root = modal.element;
  const rowsBox = root.querySelector("[data-rows]");
  const voucherInput = root.querySelector("[name='voucher']");
  const errorsBox = root.querySelector("[data-errors]");

  root.querySelector("[data-submit]").addEventListener("click", () => {
    const rows = handover.items.map((item, index) => ({
      category: item.category,
      quantity: rowsBox.querySelectorAll("[data-hw-row]")[index].querySelector("[name='quantity']").value
    }));
    const result = receiveHandover(handover, rows, voucherInput.value);
    if (!result.ok) {
      showErrors(errorsBox, result.errors.map((error) => error.message));
      return;
    }
    repair.handover = result.handover;
    repair.status = result.handover.status === "archived" ? "done" : "review";
    saveState(state);
    modal.close();
    render();
  });
}

// —— 弹窗：补处置说明 ——
function openResolveModal(repair) {
  const handover = repair.handover;
  const receipt = handover.receipt;
  const reasons = [
    ...(receipt?.voucherMissing ? ["缺凭证"] : []),
    ...((receipt?.discrepancies.length || 0) > 0 ? ["数量不符"] : [])
  ];

  const modal = openModal({
    title: `异常复核 · ${repair.location}`,
    body: `
      <div class="review-box">
        <p>冻结原因：<strong>${reasons.join("、") || "签收异常"}</strong></p>
        <ul class="h-items">
          ${handover.items
            .map(
              (item) =>
                `<li>${WASTE_CATEGORIES[item.category].label} 移交 <strong>${item.quantity}${WASTE_CATEGORIES[item.category].unit}</strong></li>`
            )
            .join("")}
        </ul>
        ${
          receipt?.discrepancies.length
            ? `<ul class="h-diff">${receipt.discrepancies
                .map((item) => `<li>${escapeHtml(item.message)}</li>`)
                .join("")}</ul>`
            : ""
        }
      </div>
      <label>补充处置说明
        <textarea name="explanation" placeholder="例如：凭证补传编号 HW-2026-009；差额 2 节废电池次日补运，联单号……"></textarea>
      </label>
      <p class="modal-tip">补说明后只释放当前事项；原移交/签收记录与历史流水保持不变，仅追加释放记录。</p>
      <div class="form-errors" data-errors hidden></div>
      <div class="modal-actions">
        <button type="button" class="danger" data-submit>补说明并释放当前事项</button>
      </div>`
  });

  const root = modal.element;
  const explanationInput = root.querySelector("[name='explanation']");
  const errorsBox = root.querySelector("[data-errors]");

  root.querySelector("[data-submit]").addEventListener("click", () => {
    const result = releaseHandover(handover, explanationInput.value);
    if (!result.ok) {
      showErrors(errorsBox, result.errors.map((error) => error.message));
      return;
    }
    repair.handover = result.handover;
    repair.status = "done";
    saveState(state);
    modal.close();
    render();
  });
}

// —— 通用弹窗骨架（无第三方依赖）——
function openModal({ title, body }) {
  const mask = document.createElement("div");
  mask.className = "modal-mask";
  mask.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h3>${escapeHtml(title)}</h3>
        <button type="button" class="ghost small" data-modal-close>关闭</button>
      </header>
      <form class="modal-body" data-modal-form>${body}</form>
    </div>`;
  document.body.appendChild(mask);

  const close = () => {
    mask.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (event) => {
    if (event.key === "Escape") close();
  };

  mask.addEventListener("mousedown", (event) => {
    if (event.target === mask) close();
  });
  mask.querySelector("[data-modal-close]").addEventListener("click", close);
  // 防止弹窗内按钮触发表单默认提交，所有提交均由各弹窗自定义处理。
  mask.querySelector("[data-modal-form]").addEventListener("submit", (event) => event.preventDefault());
  document.addEventListener("keydown", onKey);

  return { element: mask, close };
}

function showErrors(box, messages) {
  if (!messages.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `<ul>${messages.map((message) => `<li>${escapeHtml(message)}</li>`).join("")}</ul>`;
}

function formatTime(iso) {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]
  );
}
