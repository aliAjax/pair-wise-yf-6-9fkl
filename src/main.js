import "./styles.css";
import { startApp } from "./ui.js";
import { loadState, saveState } from "./storage.js";

// 组装入口：规则（rules.js）、存储（storage.js）、界面（ui.js）三文件分离
const state = loadState();
const app = startApp(state, saveState);
app.render();
