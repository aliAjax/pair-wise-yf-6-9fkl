// 本地存档：localStorage 读写、暂存点种子、危废交接台账（只追加）、归档同步

const STORAGE_KEY = "zfl-14-repairs";

// 暂存点容量按危废类别设置（数量上限），余量不足即整次拒绝
export function defaultPoints() {
  return [
    {
      id: "point-balcony",
      name: "阳台危废暂存箱",
      limits: { battery: 30, paintCan: 6, lamp: 10, solvent: 5 }
    },
    {
      id: "point-utility",
      name: "储物间危废柜",
      limits: { battery: 20, leadBattery: 2, paintCan: 4, oil: 10, lamp: 6, solvent: 8 }
    },
    {
      id: "point-garage",
      name: "车库暂存角",
      limits: { battery: 40, leadBattery: 4, paintCan: 10, oil: 20, solvent: 15 }
    }
  ];
}

export function defaultState() {
  return {
    version: 2,
    filter: "all",
    repairs: [
      {
        id: crypto.randomUUID(),
        location: "厨房",
        title: "水槽下方渗水",
        priority: "high",
        cost: 260,
        status: "todo",
        photo: "",
        note: "先检查软管接口",
        handover: null,
        finishedAt: null
      }
    ],
    points: defaultPoints(),
    ledger: [], // 危废交接台账，只追加，不改写历史
    archive: [] // 本地归档：仅已完工且未冻结的事项
  };
}

export function loadState() {
  let state = null;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved) {
    try {
      state = JSON.parse(saved);
    } catch {
      state = null;
    }
  }
  if (!state || !Array.isArray(state.repairs)) state = defaultState();
  if (!Array.isArray(state.points) || state.points.length === 0) state.points = defaultPoints();
  if (!Array.isArray(state.ledger)) state.ledger = [];
  if (!Array.isArray(state.archive)) state.archive = [];
  if (typeof state.filter !== "string") state.filter = "all";
  // 老数据补齐交接字段；刷新后全部保留
  for (const repair of state.repairs) {
    if (!("handover" in repair)) repair.handover = null;
    if (!("finishedAt" in repair)) repair.finishedAt = null;
  }
  syncArchive(state);
  return state;
}

export function saveState(state) {
  syncArchive(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// 归档与维修事项、台账同源同步；异常冻结事项不得入档；事项删除/改回处理中则撤档
export function syncArchive(state) {
  for (const repair of state.repairs) {
    const index = state.archive.findIndex((item) => item.repairId === repair.id);
    const shouldArchive = repair.status === "done" && repair.handover?.status !== "exception";
    if (shouldArchive && index === -1) {
      state.archive.push(buildArchiveRecord(repair, state.points));
    } else if (!shouldArchive && index !== -1) {
      state.archive.splice(index, 1);
    }
  }
  // 清理已删除事项遗留的归档记录（遍历 repairs 覆盖不到的孤儿记录）
  const liveIds = new Set(state.repairs.map((repair) => repair.id));
  state.archive = state.archive.filter((record) => liveIds.has(record.repairId));
  return state;
}

function buildArchiveRecord(repair, points) {
  const nameOf = (pointId) => points.find((point) => point.id === pointId)?.name || "已撤销暂存点";
  const handover = repair.handover;
  if (handover && handover.status === "signed") {
    return {
      repairId: repair.id,
      kind: "hazardous",
      location: repair.location,
      title: repair.title,
      archivedAt: new Date().toISOString(),
      finishedAt: repair.finishedAt,
      handoverId: handover.id,
      lines: handover.lines.map((line) => ({
        categoryName: line.categoryName,
        hw: line.hw,
        qty: line.qty,
        unit: line.unit,
        pointName: nameOf(line.pointId),
        voucher: handover.voucher,
        signedAt: handover.signedAt
      }))
    };
  }
  if (handover && handover.status === "released") {
    return {
      repairId: repair.id,
      kind: "released",
      location: repair.location,
      title: repair.title,
      archivedAt: new Date().toISOString(),
      finishedAt: repair.finishedAt,
      handoverId: handover.id,
      lines: handover.lines.map((line) => ({
        categoryName: line.categoryName,
        hw: line.hw,
        qty: line.qty,
        unit: line.unit,
        pointName: nameOf(line.pointId)
      })),
      resolution: handover.resolution
    };
  }
  return {
    repairId: repair.id,
    kind: "plain",
    location: repair.location,
    title: repair.title,
    archivedAt: new Date().toISOString(),
    finishedAt: repair.finishedAt
  };
}

// 台账只追加事件
export function appendLedger(state, event) {
  state.ledger.unshift({ id: crypto.randomUUID(), at: new Date().toISOString(), ...event });
}
