// 本地存档：localStorage 读写、旧版数据迁移、暂存点容量种子数据。

const STORAGE_KEY = "zfl-14-repairs";
const STATE_VERSION = 2;

export function defaultState() {
  return {
    version: STATE_VERSION,
    filter: "all",
    repairs: [
      {
        id: crypto.randomUUID(),
        location: "厨房",
        title: "水槽下方渗水",
        priority: "high",
        cost: 260,
        status: "doing",
        photo: "",
        note: "先检查软管接口，完工时登记废电池等危废",
        handover: null
      }
    ],
    storage: {
      points: [
        {
          id: "point-balcony",
          name: "阳台危废暂存柜",
          capacity: { battery: 30, paint: 8, lamp: 12, medicine: 5, oil: 4 }
        },
        {
          id: "point-garage",
          name: "车库暂存箱",
          capacity: { battery: 12, paint: 20, lamp: 6, medicine: 0, oil: 8 }
        }
      ]
    }
  };
}

function migrate(legacy) {
  const next = defaultState();
  if (legacy && typeof legacy === "object") {
    if (Array.isArray(legacy.repairs)) {
      next.repairs = legacy.repairs.map((repair) => ({
        ...repair,
        // 旧版已完成的事项视为无危废历史归档，不回填任何交接记录。
        handover: repair.handover ?? null
      }));
    }
    if (typeof legacy.filter === "string") {
      next.filter = legacy.filter === "done" ? "done" : legacy.filter;
    }
  }
  return next;
}

// 刷新与重新打开页面均从同一份本地存档恢复（筛选、余量统计随之保留）。
export function loadState() {
  let saved = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  if (!saved) return defaultState();
  if (saved.version !== STATE_VERSION) return migrate(saved);
  return saved;
}

export function saveState(state) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}
