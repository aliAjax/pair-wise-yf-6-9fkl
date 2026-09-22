// 界面层：渲染与交互；业务判定全部走 rules.js，持久化走 storage.js
import {
  CATEGORIES,
  FILTERS,
  HANDOVER_PENDING,
  HANDOVER_SIGNED,
  HANDOVER_EXCEPTION,
  HANDOVER_RELEASED,
  categoryMap,
  canArchive,
  capacityTable,
  createHandover,
  evaluateReceipt,
  filterRepairs,
  isFrozen,
  normalizeLines,
  pointName,
  resolveHandover,
  validateHandover,
  viewState
} from "./rules.js";
import { appendLedger } from "./storage.js";

const statusLabels = {
  todo: "待处理",
  doing: "处理中",
  done: "已完成"
};

const priorities = {
  high: "高优先级",
  medium: "中优先级",
  low: "低优先级"
};

const handoverBadges = {
  [HANDOVER_PENDING]: { text: "待清运签收", cls: "pending" },
  [HANDOVER_SIGNED]: { text: "已清运签收", cls: "signed" },
  [HANDOVER_EXCEPTION]: { text: "异常复核·归档冻结", cls: "exception" },
  [HANDOVER_RELEASED]: { text: "已补说明放行", cls: "released" }
};

const ledgerLabels = {
  handover: "移交登记",
  sign: "清运签收",
  reject: "余量拒绝",
  exception: "转异常复核",
  resolve: "补说明放行",
  plain: "无危废完工"
};

// 当前展开的操作面板（刷新后默认收起，数据不受影响）
let openPanel = { form: null, notice: "" };

export function startApp(state, persist) {
  const app = document.querySelector("#app");

  function render() {
    app.innerHTML = renderShell(state);
    bindEvents();
  }

  function commit(notice = "") {
    openPanel.notice = notice;
    persist(state);
    render();
  }

  // 明细行增删：常驻委托一次，innerHTML 重绘后依然有效
  app.addEventListener("click", (event) => {
    const addButton = event.target.closest("[data-add-line]");
    if (addButton) {
      app.querySelector("#handover-lines")?.insertAdjacentHTML("beforeend", handoverLineRow(state, ""));
      return;
    }
    const removeButton = event.target.closest("[data-remove-line]");
    if (removeButton) removeButton.closest(".handover-row")?.remove();
  });

  function bindEvents() {
    app.querySelector("#repair-form")?.addEventListener("submit", (event) => {
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
        handover: null,
        finishedAt: null
      });
      openPanel.form = null;
      commit("维修事项已保存");
    });

    // 顶部筛选（点击分段按钮，状态持久化，刷新后保留）
    app.querySelectorAll("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        state.filter = button.dataset.filter;
        openPanel.form = null;
        commit();
      });
    });

    // 维修事项状态切换：todo/doing/done 可自由切换，已发起交接后禁止跳过流程改完成
    app.querySelectorAll("[data-status]").forEach((select) => {
      select.addEventListener("change", () => {
        const repair = state.repairs.find((item) => item.id === select.dataset.status);
        if (!repair) return;
        if (select.value === "done" && repair.handover?.status !== HANDOVER_SIGNED && repair.handover?.status !== HANDOVER_RELEASED) {
          commit("完工前必须完成危废清运交接：登记危废或确认本次无危废");
          return;
        }
        repair.status = select.value;
        if (select.value !== "done") repair.finishedAt = null;
        commit();
      });
    });

    app.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", () => {
        const repair = state.repairs.find((item) => item.id === button.dataset.delete);
        if (repair && isFrozen(repair) && !window.confirm("该事项处于异常复核冻结中，确定删除吗？")) return;
        state.repairs = state.repairs.filter((item) => item.id !== button.dataset.delete);
        openPanel.form = null;
        commit("事项已删除（历史台账保留）");
      });
    });

    // 打开/关闭操作面板
    app.querySelectorAll("[data-open]").forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.dataset.open;
        openPanel.form = openPanel.form === key ? null : key;
        render();
      });
    });

    app.querySelectorAll("[data-close-panel]").forEach((button) => {
      button.addEventListener("click", () => {
        openPanel.form = null;
        openPanel.notice = "";
        render();
      });
    });

    // 完工登记：危废移交
    app.querySelector("#handover-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const repairId = event.target.dataset.repairId;
      const repair = state.repairs.find((item) => item.id === repairId);
      if (!repair || repair.handover) return;

      const rawRows = [...event.target.querySelectorAll(".handover-row")].map((row) => ({
        category: row.querySelector("[name='category']").value,
        pointId: row.querySelector("[name='pointId']").value,
        qty: row.querySelector("[name='qty']").value
      }));

      const { lines, errors: parseErrors } = normalizeLines(rawRows);
      if (parseErrors.length) {
        openPanel.notice = parseErrors.join("；");
        render();
        return;
      }
      // 余量校验：任何一条余量不足，整次拒绝，事项保持处理中、容量不占用
      const check = validateHandover(lines, state);
      if (!check.ok) {
        appendLedger(state, {
          type: "reject",
          repairId: repair.id,
          location: repair.location,
          title: repair.title,
          detail: check.errors.join("；"),
          lines: lines.map((line) => ({
            ...line,
            categoryName: categoryMap[line.category].name,
            pointName: pointName(state, line.pointId)
          }))
        });
        commit(check.errors.join("；"));
        return;
      }

      const handover = createHandover(lines, crypto.randomUUID, () => new Date().toISOString());
      repair.handover = handover;
      repair.status = "doing"; // 移交不等于完工，保持处理中待签收
      appendLedger(state, {
        type: "handover",
        repairId: repair.id,
        location: repair.location,
        title: repair.title,
        handoverId: handover.id,
        lines: handover.lines.map((line) => ({
          categoryName: line.categoryName,
          hw: line.hw,
          qty: line.qty,
          unit: line.unit,
          pointName: pointName(state, line.pointId)
        }))
      });
      openPanel.form = null;
      commit("危废已登记入暂存点，事项保持处理中，等待清运方签收");
    });

    // 完工登记：本次无危废（普通垃圾不入危废账）
    app.querySelector("#plain-finish-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const repair = state.repairs.find((item) => item.id === event.target.dataset.repairId);
      if (!repair || repair.handover) return;
      repair.status = "done";
      repair.finishedAt = new Date().toISOString();
      appendLedger(state, {
        type: "plain",
        repairId: repair.id,
        location: repair.location,
        title: repair.title,
        detail: "确认本次无危废，普通垃圾不入危废账"
      });
      openPanel.form = null;
      commit("事项已完工归档（无危废）");
    });

    // 清运签收：数量必须与移交一致且凭证齐全，否则转异常复核并冻结归档
    app.querySelector("#receipt-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const repair = state.repairs.find((item) => item.id === event.target.dataset.repairId);
      const handover = repair?.handover;
      if (!handover || handover.status !== HANDOVER_PENDING) return;

      const received = {};
      event.target.querySelectorAll("[data-line]").forEach((input) => {
        received[input.dataset.line] = input.value;
      });
      const voucher = new FormData(event.target).get("voucher");
      const result = evaluateReceipt(handover, received, voucher);

      if (result.ok) {
        handover.status = HANDOVER_SIGNED;
        handover.voucher = String(voucher).trim();
        handover.signedAt = new Date().toISOString();
        handover.received = Object.fromEntries(handover.lines.map((line) => [line.id, line.qty]));
        repair.status = "done";
        repair.finishedAt = handover.signedAt;
        appendLedger(state, {
          type: "sign",
          repairId: repair.id,
          location: repair.location,
          title: repair.title,
          handoverId: handover.id,
          voucher: handover.voucher,
          lines: handover.lines.map((line) => ({
            categoryName: line.categoryName,
            qty: line.qty,
            unit: line.unit,
            pointName: pointName(state, line.pointId)
          }))
        });
        openPanel.form = null;
        commit("签收数量与移交一致，危废已清运，事项完工归档");
        return;
      }

      // 缺凭证或数量不符：转异常复核，冻结归档，暂存点容量继续占用
      handover.status = HANDOVER_EXCEPTION;
      handover.exceptionAt = new Date().toISOString();
      handover.voucher = String(voucher || "").trim();
      handover.received = Object.fromEntries(
        handover.lines.map((line) => [line.id, Number(received[line.id])])
      );
      const reasons = [];
      if (result.missingVoucher) reasons.push("缺少清运签收凭证");
      for (const mismatch of result.mismatches) {
        const line = handover.lines.find((item) => item.id === mismatch.lineId);
        reasons.push(
          `${line.categoryName}签收 ${Number.isFinite(mismatch.received) ? mismatch.received : "空"}${line.unit}，` +
            `与移交 ${mismatch.handed}${line.unit} 不符`
        );
      }
      handover.reasons = reasons;
      repair.status = "doing";
      appendLedger(state, {
        type: "exception",
        repairId: repair.id,
        location: repair.location,
        title: repair.title,
        handoverId: handover.id,
        detail: reasons.join("；")
      });
      openPanel.form = null;
      commit(`已转入异常复核并冻结归档：${reasons.join("；")}。补处置说明后仅放行本事项`);
    });

    // 补处置说明：只释放当前事项，历史明细不改
    app.querySelector("#resolve-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const repair = state.repairs.find((item) => item.id === event.target.dataset.repairId);
      const handover = repair?.handover;
      if (!handover || handover.status !== HANDOVER_EXCEPTION) return;
      const explanation = new FormData(event.target).get("explanation");
      const result = resolveHandover(explanation);
      if (!result.ok) {
        openPanel.notice = result.error;
        render();
        return;
      }
      handover.status = HANDOVER_RELEASED;
      handover.resolution = {
        text: result.explanation,
        at: new Date().toISOString()
      };
      repair.status = "done";
      repair.finishedAt = handover.resolution.at;
      appendLedger(state, {
        type: "resolve",
        repairId: repair.id,
        location: repair.location,
        title: repair.title,
        handoverId: handover.id,
        detail: result.explanation
      });
      openPanel.form = null;
      commit("处置说明已登记，仅当前事项放行完工；历史移交/签收记录保持不变");
    });
  }

  return { render };
}

/* ---------------- 以下为纯渲染 ---------------- */

function renderShell(state) {
  const repairs = filterRepairs(state.repairs, state.filter);
  const unfinished = state.repairs.filter((repair) => repair.status !== "done");
  const totalCost = unfinished.reduce((total, repair) => total + Number(repair.cost || 0), 0);
  const doing = state.repairs.filter((repair) => viewState(repair) === "doing").length;
  const pending = state.repairs.filter((repair) => viewState(repair) === "pending").length;
  const exceptions = state.repairs.filter((repair) => viewState(repair) === "exception").length;
  const archived = state.archive.length;
  const table = capacityTable(state.points, state.repairs);
  const tight = table.flatMap((point) => point.rows).filter((row) => row.remaining <= 0).length;

  return `
    <main class="shell">
      <header class="header">
        <div>
          <p class="eyebrow">本地家庭维护台 · 危废清运交接</p>
          <h1>家庭维修事项</h1>
        </div>
        <section class="stats">
          <div class="stat"><span>未完成</span><strong>${unfinished.length}</strong></div>
          <div class="stat"><span>处理中</span><strong>${doing}</strong></div>
          <div class="stat"><span>待签收</span><strong>${pending}</strong></div>
          <div class="stat ${exceptions ? "warn" : ""}"><span>异常复核</span><strong>${exceptions}</strong></div>
          <div class="stat"><span>已归档</span><strong>${archived}</strong></div>
          <div class="stat"><span>预计费用</span><strong>¥${totalCost}</strong></div>
          <div class="stat ${tight ? "warn" : ""}"><span>容量告罄类别</span><strong>${tight}</strong></div>
        </section>
      </header>

      ${openPanel.notice ? `<div class="notice">${escapeHtml(openPanel.notice)}</div>` : ""}

      <section class="layout">
        <aside class="side">
          <section class="panel">
            <h2>新增维修事项</h2>
            <form class="form" id="repair-form">
              <label>位置<input name="location" required placeholder="例如卫生间"></label>
              <label>问题描述<textarea name="title" required placeholder="例如门锁松动"></textarea></label>
              <label>优先级<select name="priority">${renderPriorityOptions("medium")}</select></label>
              <label>预计费用<input name="cost" type="number" min="0" step="1" value="0"></label>
              <label>处理状态<select name="status">${renderStatusOptions("todo", false, true)}</select></label>
              <label>照片链接<input name="photo" type="url" placeholder="可选，粘贴图片地址"></label>
              <label>备注<textarea name="note" placeholder="师傅电话、材料或注意事项"></textarea></label>
              <button class="primary" type="submit">保存事项</button>
            </form>
          </section>
          ${renderCapacityPanel(state)}
        </aside>

        <section class="main-col">
          <div class="toolbar">
            ${FILTERS.map(([value, label]) =>
              `<button class="seg ${state.filter === value ? "active" : ""}" data-filter="${value}">${label}</button>`
            ).join("")}
          </div>
          <div class="repairs">
            ${repairs.length ? repairs.map((repair) => renderRepair(repair, state)).join("") : `<div class="empty">当前筛选下没有维修事项</div>`}
          </div>

          <div class="records-grid">
            ${renderArchivePanel(state)}
            ${renderLedgerPanel(state)}
          </div>
        </section>
      </section>
    </main>
  `;
}

function renderCapacityPanel(state) {
  const table = capacityTable(state.points, state.repairs);
  return `
    <section class="panel capacity">
      <h2>暂存点余量</h2>
      <p class="hint">余量 = 容量 − 待签收/异常冻结在库量；余量不足则整次移交拒绝</p>
      <div class="points">
        ${table.map((point) => `
          <div class="point">
            <h3>${escapeHtml(point.name)}</h3>
            <ul>
              ${point.rows.map((row) => `
                <li class="${row.remaining <= 0 ? "full" : row.ratio >= 0.8 ? "tight" : ""}">
                  <div class="cap-head">
                    <span>${escapeHtml(row.name)}</span>
                    <strong>${row.remaining}${escapeHtml(row.unit)}</strong>
                  </div>
                  <div class="cap-bar"><i style="width:${Math.min(100, Math.round(row.ratio * 100))}%"></i></div>
                  <small>在库 ${row.used}/${row.limit}${escapeHtml(row.unit)} · ${escapeHtml(row.hw)}</small>
                </li>
              `).join("")}
            </ul>
          </div>
        `).join("")}
      </div>
    </section>
  `;
}

function renderRepair(repair, state) {
  const stateKey = viewState(repair);
  const locked = Boolean(repair.handover) && repair.handover.status !== HANDOVER_SIGNED && repair.handover.status !== HANDOVER_RELEASED;
  return `
    <article class="repair">
      <div class="photo">${repair.photo ? `<img src="${escapeHtml(repair.photo)}" alt="${escapeHtml(repair.location)}维修照片">` : "未添加照片"}</div>
      <div class="content">
        <div class="row">
          <h3>${escapeHtml(repair.location)}</h3>
          <span class="priority ${repair.priority}">${priorities[repair.priority]}</span>
          <span class="status ${repair.status}">${statusLabels[repair.status]}</span>
          ${repair.handover ? `<span class="hz-badge ${handoverBadges[repair.handover.status].cls}">${handoverBadges[repair.handover.status].text}</span>` : ""}
          ${isFrozen(repair) ? `<span class="freeze-tag">归档冻结</span>` : ""}
        </div>
        <p>${escapeHtml(repair.title)}</p>
        <div class="row">
          <span class="chip">预计 ¥${Number(repair.cost || 0)}</span>
          <span class="chip">${escapeHtml(repair.note || "暂无备注")}</span>
          ${repair.finishedAt ? `<span class="chip">完工 ${formatDate(repair.finishedAt)}</span>` : ""}
        </div>
        ${renderHandoverDetail(repair, state)}
        ${renderActionPanel(repair, state, stateKey, locked)}
        <div class="actions">
          <select data-status="${repair.id}" ${locked ? "disabled" : ""}>
            ${renderStatusOptions(repair.status, locked)}
          </select>
          <button class="ghost" data-delete="${repair.id}">删除</button>
        </div>
      </div>
    </article>
  `;
}

function renderHandoverDetail(repair, state) {
  const handover = repair.handover;
  if (!handover) return "";
  const badge = handoverBadges[handover.status];
  return `
    <div class="hz-detail ${handover.status}">
      <div class="hz-title">危废交接单 <code>${escapeHtml(handover.id.slice(0, 8))}</code> · 登记于 ${formatDate(handover.createdAt)}</div>
      <ul class="hz-lines">
        ${handover.lines.map((line) => `
          <li>
            <span>${escapeHtml(line.categoryName)}</span>
            <span class="hw">${escapeHtml(line.hw)}</span>
            <span>移交 ${line.qty}${escapeHtml(line.unit)}</span>
            ${handover.status === HANDOVER_PENDING || handover.status === HANDOVER_EXCEPTION || handover.status === HANDOVER_SIGNED
              ? `<span>签收 ${handover.status === HANDOVER_PENDING ? "待签" : formatReceived(handover, line)}${escapeHtml(line.unit)}</span>`
              : ""}
            <span class="point">${escapeHtml(pointName(state, line.pointId))}</span>
          </li>
        `).join("")}
      </ul>
      ${handover.voucher ? `<p class="voucher">清运凭证：${escapeHtml(handover.voucher)}</p>` : ""}
      ${handover.reasons?.length ? `<p class="reasons">异常原因：${escapeHtml(handover.reasons.join("；"))}</p>` : ""}
      ${handover.resolution ? `<p class="resolution">处置说明（${formatDate(handover.resolution.at)}）：${escapeHtml(handover.resolution.text)}</p>` : ""}
      ${handover.status === HANDOVER_SIGNED ? `<p class="ok-line">签收一致并已清运：${formatDate(handover.signedAt)}</p>` : ""}
      ${handover.status === HANDOVER_RELEASED ? `<p class="ok-line">仅本事项经处置说明放行，历史移交/签收记录未改动</p>` : ""}
      <span class="hz-state ${badge.cls}">${badge.text}</span>
    </div>
  `;
}

function formatReceived(handover, line) {
  const value = handover.received?.[line.id];
  if (value === undefined || Number.isNaN(Number(value))) return "—";
  return Number(value);
}

function renderActionPanel(repair, state, stateKey, locked) {
  if (stateKey === "done" && canArchive(repair) && repair.handover?.status === HANDOVER_SIGNED) {
    return `<p class="flow-hint">✅ 已随签收一致完工并归档</p>`;
  }
  if (repair.handover?.status === HANDOVER_RELEASED) {
    return `<p class="flow-hint">✅ 补处置说明后放行，已归档；历史记录未改动</p>`;
  }
  if (!repair.handover && repair.status !== "done") {
    if (openPanel.form === `handover:${repair.id}`) return handoverForm(repair, state);
    if (openPanel.form === `plain:${repair.id}`) return plainFinishForm(repair);
    return `
      <div class="hz-actions">
        <button class="primary small" data-open="handover:${repair.id}">完工登记危废移交</button>
        <button class="ghost" data-open="plain:${repair.id}">本次无危废，直接完工</button>
      </div>
      <p class="hint">仅废电池、油漆桶等目录内危废可入账；普通生活垃圾不得登记</p>
    `;
  }
  if (repair.handover?.status === HANDOVER_PENDING) {
    if (openPanel.form === `receipt:${repair.id}`) return receiptForm(repair);
    return `
      <div class="hz-actions">
        <button class="primary small" data-open="receipt:${repair.id}">清运方签收登记</button>
      </div>
      <p class="hint">签收数量须与移交逐项一致并填写凭证，否则转异常复核并冻结归档</p>
    `;
  }
  if (repair.handover?.status === HANDOVER_EXCEPTION) {
    if (openPanel.form === `resolve:${repair.id}`) return resolveForm(repair);
    return `
      <div class="hz-actions">
        <button class="danger small" data-open="resolve:${repair.id}">补处置说明，申请放行</button>
      </div>
      <p class="hint">冻结中：补说明通过后只释放当前事项，历史不改，容量在放行时释放</p>
    `;
  }
  return "";
}

function handoverLineRow(state, selected) {
  return `
    <div class="handover-row">
      <select name="category">
        <option value="">危废类别…</option>
        ${CATEGORIES.map((cat) => `<option value="${cat.code}">${cat.name}（${cat.unit}/${cat.hw}）</option>`).join("")}
      </select>
      <select name="pointId">
        <option value="">暂存点…</option>
        ${state.points.map((point) => `<option value="${point.id}">${escapeHtml(point.name)}</option>`).join("")}
      </select>
      <input name="qty" type="number" min="0" step="0.01" placeholder="数量">
      <button type="button" class="ghost icon-btn" data-remove-line title="删除本行">×</button>
    </div>
  `;
}

function handoverForm(repair, state) {
  return `
    <form class="panel-sub" id="handover-form" data-repair-id="${repair.id}">
      <h4>危废移交登记（完工时）</h4>
      <div id="handover-lines" class="handover-lines">
        ${handoverLineRow(state, "")}
      </div>
      <button type="button" class="ghost small" data-add-line>+ 增加一条危废</button>
      <div class="form-actions">
        <button class="primary small" type="submit">校验余量并移交暂存</button>
        <button type="button" class="ghost small" data-close-panel>取消</button>
      </div>
    </form>
  `;
}

function plainFinishForm(repair) {
  return `
    <form class="panel-sub" id="plain-finish-form" data-repair-id="${repair.id}">
      <h4>确认本次无危废</h4>
      <p class="hint">普通垃圾不走危废账，也不占用暂存点容量；确认后事项直接完工归档。</p>
      <div class="form-actions">
        <button class="primary small" type="submit">确认无危废并完工</button>
        <button type="button" class="ghost small" data-close-panel>取消</button>
      </div>
    </form>
  `;
}

function receiptForm(repair) {
  const handover = repair.handover;
  return `
    <form class="panel-sub" id="receipt-form" data-repair-id="${repair.id}">
      <h4>清运签收登记</h4>
      <ul class="receipt-lines">
        ${handover.lines.map((line) => `
          <li>
            <span>${escapeHtml(line.categoryName)} · 移交 <b>${line.qty}${escapeHtml(line.unit)}</b></span>
            <label class="inline">实收
              <input data-line="${line.id}" type="number" min="0" step="0.01" value="${line.qty}">${escapeHtml(line.unit)}
            </label>
          </li>
        `).join("")}
      </ul>
      <label>清运凭证编号 / 联单
        <input name="voucher" placeholder="选填校验：留空提交将按缺凭证转入异常复核">
      </label>
      <div class="form-actions">
        <button class="primary small" type="submit">提交签收</button>
        <button type="button" class="ghost small" data-close-panel>取消</button>
      </div>
    </form>
  `;
}

function resolveForm(repair) {
  return `
    <form class="panel-sub danger-panel" id="resolve-form" data-repair-id="${repair.id}">
      <h4>异常复核 · 补处置说明</h4>
      <label>处置说明（差异去向 / 补凭证情况）
        <textarea name="explanation" required placeholder="例如：实差 1 桶油漆桶遗落现场，已于次日补运，附联单 X-2026-009"></textarea>
      </label>
      <div class="form-actions">
        <button class="danger small" type="submit">提交说明并放行本事项</button>
        <button type="button" class="ghost small" data-close-panel>取消</button>
      </div>
    </form>
  `;
}

function renderArchivePanel(state) {
  const frozen = state.repairs.filter(isFrozen);
  return `
    <section class="panel records">
      <h2>本地存档（${state.archive.length}）</h2>
      <p class="hint">随事项与台账实时同步；异常冻结事项不入档</p>
      ${frozen.length ? `<p class="reasons">⛏ 冻结中 ${frozen.length} 项：${frozen.map((item) => escapeHtml(item.location)).join("、")}</p>` : ""}
      <ul class="archive-list">
        ${state.archive.length ? state.archive.map((record) => `
          <li>
            <div class="arc-head">
              <span class="arc-kind ${record.kind}">${record.kind === "hazardous" ? "危废签收" : record.kind === "released" ? "异常放行" : "无危废"}</span>
              <b>${escapeHtml(record.location)} · ${escapeHtml(record.title)}</b>
            </div>
            ${record.lines ? `
              <ul class="arc-lines">
                ${record.lines.map((line) => `
                  <li>${escapeHtml(line.categoryName)} ${line.qty}${escapeHtml(line.unit)} · ${escapeHtml(line.pointName)}${line.voucher ? ` · 凭证 ${escapeHtml(line.voucher)}` : ""}</li>
                `).join("")}
              </ul>` : ""}
            ${record.resolution ? `<p class="resolution">处置说明：${escapeHtml(record.resolution.text)}</p>` : ""}
            <small>归档 ${formatDate(record.archivedAt)}</small>
          </li>
        `).join("") : `<li class="empty">暂无归档记录</li>`}
      </ul>
    </section>
  `;
}

function renderLedgerPanel(state) {
  return `
    <section class="panel records">
      <h2>危废交接台账（${state.ledger.length}）</h2>
      <p class="hint">只追加，不改写历史；含移交、签收、余量拒绝、异常与放行记录</p>
      <ul class="ledger-list">
        ${state.ledger.length ? state.ledger.map((event) => `
          <li class="ledger ${event.type}">
            <div class="led-head">
              <span class="led-type">${ledgerLabels[event.type] || event.type}</span>
              <small>${formatDate(event.at)}</small>
            </div>
            <div class="led-body">${escapeHtml(event.location)} · ${escapeHtml(event.title)}</div>
            ${event.lines ? `<div class="led-lines">${event.lines.map((line) =>
              `${escapeHtml(line.categoryName)} ${line.qty}${escapeHtml(line.unit)}（${escapeHtml(line.pointName)}）`
            ).join("；")}</div>` : ""}
            ${event.detail ? `<div class="led-detail">${escapeHtml(event.detail)}</div>` : ""}
            ${event.voucher ? `<div class="led-detail">凭证：${escapeHtml(event.voucher)}</div>` : ""}
          </li>
        `).join("") : `<li class="empty">暂无台账记录</li>`}
      </ul>
    </section>
  `;
}

function renderStatusOptions(selected, locked, hideDone) {
  return [
    ["todo", "待处理"],
    ["doing", "处理中"],
    ...(locked || hideDone ? [] : [["done", "已完成"]])
  ].map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`).join("");
}

function renderPriorityOptions(selected) {
  return Object.entries(priorities)
    .map(([value, label]) => `<option value="${value}" ${selected === value ? "selected" : ""}>${label}</option>`)
    .join("");
}

function formatDate(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[char]);
}
