# 词典目录说明 (`dict/`)

本目录将所有中英文词条与安全保护规则拆分为独立 JSON 文件，便于非开发背景的维护者直接增删改查，完全无需修改核心代码：

- `native-menu.json`：Electron 原生顶部菜单、系统托盘菜单、退出确认与更新弹窗。
- `ui-static.json`：Antigravity 主界面常规静态按钮、侧边栏、设置页、标签文案。
- `ui-patterns.json`：带动态参数的模板规则（例如 `3 files changed`、`Updated 5m ago`）。
- `high-risk-bilingual.json`：**高风险操作与终端命令授权强制双语词库**（必须保留英文原文对照，例如 `Allow` → `允许执行 (Allow)`）。
- `sandbox-rules.json`：物理免疫区选择器、斜杠指令保留白名单与代码特征防误伤规则。
