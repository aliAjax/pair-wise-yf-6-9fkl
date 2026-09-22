// 危废清运交接业务规则：纯逻辑，不依赖 DOM 与 localStorage。

export const REPAIR_STATUSES = {
  all: "全部",
  todo: "待处理",
  doing: "处理中",
  waiting: "待签收",
  review: "异常复核",
  done: "已归档"
};

// 事项只能在非终态之间手动切换；完工必须走危废移交登记。
export const SELECTABLE_STATUSES = ["todo", "doing"];

// 危废白名单：只有下列类别可以入账，普通垃圾一律拒收。
export const WASTE_CATEGORIES = {
  battery: { label: "废电池", unit: "节", integer: true },
  paint: { label: "油漆桶", unit: "个", integer: true },
  lamp: { label: "废荧光灯管", unit: "根", integer: true },
  medicine: { label: "废药品及包装", unit: "千克", integer: false },
  oil: { label: "废矿物油", unit: "千克", integer: false }
};

export const HISTORY_LABELS = {
  transfer: "完工移交登记",
  receipt: "清运签收",
  freeze: "冻结归档",
  release: "补说明释放"
};

export function nowStamp() {
  return new Date().toISOString();
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function isHazardCategory(category) {
  return Object.prototype.hasOwnProperty.call(WASTE_CATEGORIES, category);
}

// 尚未归档的交接仍实际占用暂存点（待签收、异常复核均算在库）。
export function activeHandover(repair) {
  return repair.handover && repair.handover.status !== "archived" ? repair.handover : null;
}

export function occupancyByPoint(state) {
  const map = {};
  for (const repair of state.repairs) {
    const handover = activeHandover(repair);
    if (!handover) continue;
    map[handover.pointId] ??= {};
    for (const item of handover.items) {
      map[handover.pointId][item.category] = round2(
        (map[handover.pointId][item.category] || 0) + item.quantity
      );
    }
  }
  return map;
}

// 余量统计：界面与本地存档共用同一份派生数据。
export function storageStats(state) {
  const occupancy = occupancyByPoint(state);
  return state.storage.points.map((point) => ({
    id: point.id,
    name: point.name,
    rows: Object.keys(WASTE_CATEGORIES).map((category) => {
      const capacity = Number(point.capacity[category] || 0);
      const occupied = round2(occupancy[point.id]?.[category] || 0);
      const remaining = round2(capacity - occupied);
      return {
        category,
        label: WASTE_CATEGORIES[category].label,
        unit: WASTE_CATEGORIES[category].unit,
        capacity,
        occupied,
        remaining,
        level:
          capacity === 0
            ? "none"
            : remaining <= 0
              ? "danger"
              : remaining / capacity <= 0.2
                ? "warn"
                : "ok"
      };
    })
  }));
}

function describeItem(category, quantity) {
  const meta = WASTE_CATEGORIES[category];
  return `${meta.label} ${quantity}${meta.unit}`;
}

// 解析并合并登记行：类别必须在白名单内（普通垃圾拒绝），数量必须为正。
export function normalizeWasteRows(rawRows) {
  const errors = [];
  const merged = new Map();

  rawRows.forEach((row, index) => {
    const category = String(row.category || "").trim();
    if (!isHazardCategory(category)) {
      errors.push({
        index,
        code: "ordinary",
        message: `第 ${index + 1} 行：普通垃圾不属于危废，不得入账`
      });
      return;
    }

    const meta = WASTE_CATEGORIES[category];
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) {
      errors.push({
        index,
        code: "quantity",
        message: `第 ${index + 1} 行：${meta.label}数量必须大于 0`
      });
      return;
    }
    if (meta.integer && !Number.isInteger(quantity)) {
      errors.push({
        index,
        code: "quantity",
        message: `第 ${index + 1} 行：${meta.label}数量必须为整数`
      });
      return;
    }

    const value = meta.integer ? quantity : round2(quantity);
    merged.set(category, round2((merged.get(category) || 0) + value));
  });

  return {
    items: [...merged.entries()].map(([category, quantity]) => ({ category, quantity })),
    errors
  };
}

// 完工移交：任一类别余量不足都整次拒绝，事项保持原状态（处理中）。
export function prepareHandover(state, repair, input, now = nowStamp()) {
  if (!repair) {
    return { ok: false, errors: [{ code: "repair", message: "事项不存在" }] };
  }
  if (activeHandover(repair)) {
    return { ok: false, errors: [{ code: "state", message: "该事项已有进行中的危废交接" }] };
  }

  const errors = [];
  const pointId = String(input?.pointId || "");
  const point = state.storage.points.find((item) => item.id === pointId);
  if (!point) {
    errors.push({ code: "point", message: "请选择有效的暂存点" });
  }

  const { items, errors: rowErrors } = normalizeWasteRows(input?.rows || []);
  errors.push(...rowErrors);
  if (items.length === 0 && errors.length === 0) {
    errors.push({ code: "empty", message: "请至少登记一类危废；本次确无危废请走“直接完工”" });
  }

  if (point && items.length > 0) {
    const used = occupancyByPoint(state)[point.id] || {};
    for (const item of items) {
      const capacity = Number(point.capacity[item.category] || 0);
      const occupied = used[item.category] || 0;
      const remaining = round2(capacity - occupied);
      if (occupied + item.quantity > capacity + 1e-9) {
        errors.push({
          code: "capacity",
          category: item.category,
          message:
            `${point.name}「${WASTE_CATEGORIES[item.category].label}」余量仅剩 ` +
            `${remaining}${WASTE_CATEGORIES[item.category].unit}，本次需 ${item.quantity}` +
            `${WASTE_CATEGORIES[item.category].unit}，余量不足，整次移交已拒绝，事项保持处理中`
        });
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    handover: {
      id: crypto.randomUUID(),
      createdAt: now,
      pointId: point.id,
      pointName: point.name,
      items,
      status: "waiting",
      receipt: null,
      resolution: null,
      history: [
        {
          at: now,
          action: "transfer",
          detail: `完工移交至${point.name}：${items
            .map((item) => describeItem(item.category, item.quantity))
            .join("、")}`
        }
      ]
    }
  };
}

// 清运签收：签收数量必须与移交一致，且必须有凭证；否则转入异常复核并冻结归档。
export function receiveHandover(handover, rawRows, voucherRaw, now = nowStamp()) {
  if (!handover || handover.status !== "waiting") {
    return { ok: false, errors: [{ code: "state", message: "当前交接状态不可签收" }] };
  }

  const expected = new Map(handover.items.map((item) => [item.category, item.quantity]));
  const received = new Map();
  const errors = [];

  (rawRows || []).forEach((row, index) => {
    const category = String(row.category || "").trim();
    const meta = WASTE_CATEGORIES[category];
    if (!expected.has(category)) {
      errors.push({ index, code: "category", message: `第 ${index + 1} 行：存在移交清单之外的类别` });
      return;
    }
    const quantity = Number(row.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      errors.push({ index, code: "quantity", message: `第 ${index + 1} 行：${meta?.label || category}签收数量无效` });
      return;
    }
    if (meta.integer && !Number.isInteger(quantity)) {
      errors.push({ index, code: "quantity", message: `第 ${index + 1} 行：${meta.label}签收数量必须为整数` });
      return;
    }
    received.set(category, meta.integer ? quantity : round2(quantity));
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const voucher = String(voucherRaw || "").trim();
  const voucherMissing = voucher.length === 0;
  const discrepancies = [];

  for (const [category, expectedQuantity] of expected) {
    const actual = received.get(category);
    if (actual === undefined) {
      discrepancies.push({
        category,
        expected: expectedQuantity,
        actual: null,
        message: `${WASTE_CATEGORIES[category].label}未填报签收数量`
      });
    } else if (Math.abs(actual - expectedQuantity) > 1e-9) {
      discrepancies.push({
        category,
        expected: expectedQuantity,
        actual,
        message:
          `${WASTE_CATEGORIES[category].label}签收 ${actual}${WASTE_CATEGORIES[category].unit}，` +
          `与移交 ${expectedQuantity}${WASTE_CATEGORIES[category].unit}不一致`
      });
    }
  }

  const frozen = voucherMissing || discrepancies.length > 0;
  const receipt = {
    at: now,
    voucher,
    voucherMissing,
    items: [...received.entries()].map(([category, quantity]) => ({ category, quantity })),
    discrepancies,
    matched: !frozen
  };

  const history = [
    ...handover.history,
    {
      at: now,
      action: "receipt",
      detail:
        `清运签收：${[...received.entries()]
          .map(([category, quantity]) => describeItem(category, quantity))
          .join("、")}` +
        (voucher ? `；凭证 ${voucher}` : "；缺少签收凭证") +
        (frozen ? "" : "；数量一致，准予归档")
    }
  ];

  if (frozen) {
    const reasons = [
      ...(voucherMissing ? ["缺凭证"] : []),
      ...(discrepancies.length > 0 ? ["数量不符"] : [])
    ];
    history.push({
      at: now,
      action: "freeze",
      detail: `${reasons.join("、")}，转入异常复核并冻结归档` +
        (discrepancies.length ? `（${discrepancies.map((item) => item.message).join("；")}）` : "")
    });
  }

  return {
    ok: true,
    handover: {
      ...handover,
      status: frozen ? "review" : "archived",
      receipt,
      history
    }
  };
}

// 补处置说明：只释放当前事项，原移交/签收记录保持不变，历史仅追加。
export function releaseHandover(handover, explanationRaw, now = nowStamp()) {
  if (!handover || handover.status !== "review") {
    return { ok: false, errors: [{ code: "state", message: "仅异常复核中的交接可以补充处置说明" }] };
  }

  const explanation = String(explanationRaw || "").trim();
  if (explanation.length < 4) {
    return { ok: false, errors: [{ code: "explanation", message: "请填写处置说明（至少 4 个字）" }] };
  }

  return {
    ok: true,
    handover: {
      ...handover,
      status: "archived",
      resolution: { at: now, explanation },
      history: [
        ...handover.history,
        {
          at: now,
          action: "release",
          detail: `补处置说明后仅释放当前事项：${explanation}`
        }
      ]
    }
  };
}
