// 危废清运交接业务规则（纯函数：不碰 DOM、不碰 localStorage）

// 危废白名单：只有目录内的危险废物可以登记入账，普通生活垃圾一律拒绝
export const CATEGORIES = [
  { code: "battery", name: "废干电池/镍镉电池", hw: "HW49 900-044-49", unit: "个" },
  { code: "leadBattery", name: "废铅酸蓄电池", hw: "HW49 900-044-49", unit: "块" },
  { code: "paintCan", name: "废油漆桶", hw: "HW49 900-041-49", unit: "桶" },
  { code: "lamp", name: "废荧光灯管", hw: "HW29 900-023-29", unit: "支" },
  { code: "oil", name: "废矿物油", hw: "HW08 900-249-08", unit: "kg" },
  { code: "solvent", name: "废有机溶剂/稀释剂", hw: "HW06 900-402-06", unit: "kg" }
];

export const categoryMap = Object.fromEntries(CATEGORIES.map((item) => [item.code, item]));

// 交接单生命周期
export const HANDOVER_PENDING = "pending"; // 已登记入暂存点，待清运方签收
export const HANDOVER_SIGNED = "signed"; // 签收一致：废物已清运、容量释放
export const HANDOVER_EXCEPTION = "exception"; // 缺凭证/数量不符：异常复核，归档冻结
export const HANDOVER_RELEASED = "released"; // 补处置说明后仅放行当前事项

// 顶部筛选（含危废交接衍生状态）
export const FILTERS = [
  ["all", "全部"],
  ["todo", "待处理"],
  ["doing", "处理中"],
  ["pending", "待签收"],
  ["exception", "异常复核"],
  ["done", "已完成"]
];

export function isHazWaste(code) {
  return Object.prototype.hasOwnProperty.call(categoryMap, code);
}

// 事项在界面上的综合状态（status + 交接单状态共同决定）
export function viewState(repair) {
  if (repair.status === "todo") return "todo";
  if (repair.status === "done") return "done";
  if (repair.handover?.status === HANDOVER_PENDING) return "pending";
  if (repair.handover?.status === HANDOVER_EXCEPTION) return "exception";
  return "doing";
}

export function filterRepairs(repairs, filter) {
  if (filter === "all") return repairs;
  return repairs.filter((repair) => viewState(repair) === filter);
}

// 异常复核中的事项冻结归档
export function isFrozen(repair) {
  return repair.handover?.status === HANDOVER_EXCEPTION;
}

export function canArchive(repair) {
  return repair.status === "done" && !isFrozen(repair);
}

// 仍压在暂存点里的危废：待签收 + 异常冻结的交接单都占位；已签收/已放行的已清运释放
export function computeOccupancy(repairs) {
  const occupied = new Map();
  const bump = (pointId, category, qty) => {
    if (!occupied.has(pointId)) occupied.set(pointId, new Map());
    const byCategory = occupied.get(pointId);
    byCategory.set(category, (byCategory.get(category) || 0) + qty);
  };
  for (const repair of repairs) {
    const handover = repair.handover;
    if (!handover) continue;
    if (handover.status !== HANDOVER_PENDING && handover.status !== HANDOVER_EXCEPTION) continue;
    for (const line of handover.lines) bump(line.pointId, line.category, Number(line.qty));
  }
  return occupied;
}

// 暂存点余量统计表
export function capacityTable(points, repairs) {
  const occupied = computeOccupancy(repairs);
  return points.map((point) => ({
    id: point.id,
    name: point.name,
    rows: Object.entries(point.limits).map(([code, limit]) => {
      const category = categoryMap[code];
      const used = occupied.get(point.id)?.get(code) || 0;
      const remaining = limit - used;
      return {
        code,
        name: category.name,
        unit: category.unit,
        hw: category.hw,
        limit,
        used,
        remaining,
        ratio: limit > 0 ? used / limit : 1
      };
    })
  }));
}

// 解析表单原始明细行：空行跳过；半填写行、非危废类别、非法数量直接报错
export function normalizeLines(rawRows) {
  const lines = [];
  const errors = [];
  let nonEmpty = 0;

  rawRows.forEach((row, index) => {
    const category = String(row.category || "").trim();
    const pointId = String(row.pointId || "").trim();
    const rawQty = String(row.qty ?? "").trim();
    if (!category && !pointId && !rawQty) return; // 整行留空＝不用的行
    nonEmpty += 1;

    const qty = Number(rawQty);
    if (!category || !isHazWaste(category)) {
      errors.push(`第 ${index + 1} 行：危废类别不在白名单内，普通垃圾不得入账`);
      return;
    }
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`第 ${index + 1} 行：${categoryMap[category].name}数量必须大于 0`);
      return;
    }
    if (!pointId) {
      errors.push(`第 ${index + 1} 行：${categoryMap[category].name}未选择暂存点`);
      return;
    }
    lines.push({ category, qty, pointId });
  });

  if (nonEmpty === 0) errors.push("至少登记一条危废明细；本次若无危废，请走“无危废直接完工”");
  return { lines, errors };
}

// 完工移交校验：任何一条不满足（类别/暂存点/余量），整次拒绝、不占用任何容量
export function validateHandover(lines, state) {
  const errors = [];
  const occupied = computeOccupancy(state.repairs);

  for (const pointId of new Set(lines.map((line) => line.pointId))) {
    const point = state.points.find((item) => item.id === pointId);
    if (!point) {
      errors.push("暂存点不存在或已撤销，整次移交已拒绝");
      continue;
    }
    const need = new Map();
    for (const line of lines.filter((item) => item.pointId === pointId)) {
      need.set(line.category, (need.get(line.category) || 0) + line.qty);
    }
    for (const [category, qty] of need) {
      const categoryInfo = categoryMap[category];
      const limit = point.limits[category];
      if (limit === undefined) {
        errors.push(`${point.name} 不接收${categoryInfo.name}（${categoryInfo.hw}），整次移交已拒绝`);
        continue;
      }
      const used = occupied.get(pointId)?.get(category) || 0;
      const remaining = limit - used;
      if (qty > remaining) {
        errors.push(
          `${point.name}「${categoryInfo.name}」余量不足：需 ${qty}${categoryInfo.unit}，` +
            `现剩 ${remaining}${categoryInfo.unit}（已暂存 ${used}/${limit}${categoryInfo.unit}），整次移交已拒绝`
        );
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function createHandover(lines, uid, nowIso) {
  return {
    id: uid(),
    createdAt: nowIso(),
    lines: lines.map((line) => ({
      id: uid(),
      category: line.category,
      qty: line.qty,
      pointId: line.pointId,
      // 名称快照入单，历史记录不受后续基础资料变动影响
      categoryName: categoryMap[line.category].name,
      unit: categoryMap[line.category].unit,
      hw: categoryMap[line.category].hw
    })),
    status: HANDOVER_PENDING,
    received: {},
    voucher: "",
    reasons: null,
    signedAt: null,
    exceptionAt: null,
    resolution: null
  };
}

// 签收判定：凭证必填，且每个明细的签收数量必须与移交数量严格一致
export function evaluateReceipt(handover, receivedInput, voucher) {
  const missingVoucher = !String(voucher ?? "").trim();
  const mismatches = [];
  for (const line of handover.lines) {
    const received = Number(receivedInput[line.id]);
    if (!Number.isFinite(received) || received !== Number(line.qty)) {
      mismatches.push({ lineId: line.id, category: line.category, handed: line.qty, received });
    }
  }
  return { ok: !missingVoucher && mismatches.length === 0, missingVoucher, mismatches };
}

// 补处置说明：只放行当前事项；校验通过后由调用方追加台账事件，历史明细一律不改
export function resolveHandover(explanation) {
  const text = String(explanation ?? "").trim();
  if (!text) return { ok: false, error: "处置说明不能为空：需说明差异去向或补凭证情况" };
  return { ok: true, explanation: text };
}

export function pointName(state, pointId) {
  return state.points.find((point) => point.id === pointId)?.name || "已撤销暂存点";
}
