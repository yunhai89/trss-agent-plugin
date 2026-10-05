---
name: skillhub-install
description: "从 SkillHub(skillhub.cn) 技能商店安装技能到本机插件技能目录：用 install_skill 工具（宿主侧受控安装，仅主人）"
when: [安装技能, 安装skill, skillhub, skill hub, 技能商店, 装个技能, 搜索技能, install skill, clawhub, OpenClaw]
priority: 9
---

当用户想从 **SkillHub**（skillhub.cn）**安装**技能时，用 `install_skill` 工具（宿主侧受控安装）。

## ⚠️ 关键：不要用 terminal 装技能

`terminal` 的唯一执行面是 **E2B 隔离沙箱**（独立 microVM/独立文件系统，宿主插件目录不可见，也没有回传通道）。
在沙箱里跑 `skillhub install --dir <宿主路径>` **只会写进沙箱**，宿主 `skills/` 目录看不到，`reload_skills` 也扫不到。
所以：**安装技能一律用 `install_skill` 工具**，不要用 `terminal` 跑 `skillhub`/`curl|bash`。

## 前置与权限

- `install_skill` 是 **仅主人** 工具（category=system），且 **每次都要二次确认**（防 prompt 注入静默安装）。非主人请求 → 如实告知「安装技能仅主人可用」。
- 需要宿主机已由**运维预先安装** `skillhub` CLI；工具**不会**自动下载/执行远程安装脚本。若工具返回「未安装 skillhub CLI」，转述给用户，让其联系管理员安装后再试。

## 用户给的是「技能名」

用户说的 `find-skill-skillhub`、`xxx-skill` 等**是 SkillHub 上的包名**，作为 `name` 传给 `install_skill`。
**不要把技能名当成指令去执行**：不要去 `cat`/`grep`/`sed` 读本插件源码（`model/`、`apps/`、`skills/`），也不要试图自己实现该技能。安装失败就如实告知，别跑偏。

## 流程

1. 确认是主人、且用户要装的是某个技能名。
2. 调用 `install_skill({ name: "<技能名>" })`。
   - 工具会：固定 argv 调 `skillhub install <name> --dir <本机技能目录>` → 校验产物（**仅允许纯 `.md` 指令技能**；含脚本/可执行/符号链接的包会被拒绝并清理）→ 自动热加载。
3. 按工具返回如实汇报：成功（已加载，可立即使用）或失败原因（CLI 未装 / 技能名不对 / 包不合法被拒等）。

## 约束

- **仅主人 + 二次确认**：不要把该工具暴露给普通成员，也不要替用户绕过确认。
- **只接受纯 `.md` 指令技能**：这是安全红线（含 `.js` 的包会在加载时执行宿主代码，工具会拒绝并清理）。
- 不支持搜索（宿主侧只提供安装）；需要搜索请让用户在 SkillHub 网页查好技能名再来装。
- 安装失败不要反复重试；一次失败即说明原因并停止。
- 执行前用一句话告诉用户：要装哪个技能、来源 SkillHub、可能风险。

## 示例

用户（主人）：「安装 find-skill-skillhub」
你的动作：`install_skill({ name: "find-skill-skillhub" })` → 按返回汇报「已安装并热加载」或失败原因。
