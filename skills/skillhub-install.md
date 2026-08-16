---
name: skillhub-install
description: "从 SkillHub(skillhub.cn) 技能商店安装/搜索技能：用 terminal 工具按官方流程把技能装进本插件技能目录"
when: [安装技能, 安装skill, skillhub, skill hub, 技能商店, 装个技能, 搜索技能, install skill, clawhub, OpenClaw]
priority: 9
---

当用户想从 **SkillHub**（skillhub.cn，国内 Skill 商店）安装或搜索技能时，用 `terminal` 工具按官方流程操作。

## ⚠️ 关键：用户给的是「技能名」，不是「动作」

用户说的 `find-skill-skillhub`、`xxx-skill` 等**是技能的名字（skillhub 上的一个包）**，要作为参数传给 `skillhub install <名字>` 安装它。
**不要把技能名当成指令去执行**——例如不要因为叫 `find-skill-...` 就去"找 skill"、去 `cat`/`sed`/`grep` 读本插件源码（`model/skill/`、`apps/` 等）、也不要试图自己实现/手写这个技能。
正确做法只有一条：用 `skillhub` CLI 把它下载装进技能目录，仅此而已。

## 前置：确认终端已启用

**先看上方【运行能力盘点】的「终端执行」一项**：
- **✅已启用** → 继续，用 `terminal` 工具执行下面的命令。
- **❌未启用** → **不要说"我没有终端能力"**；如实告诉用户：「安装技能需要终端执行能力，当前未启用。请在配置 `agent.terminal.enable: true` 开启后发 `#agents重载`，再让我安装。」然后停止。

**技能目录**已写在【运行能力盘点】里，安装时**必须**用 `--dir` 指向它，否则装到默认 `./skills/` 不会被识别。

## 流程

1. **检查 CLI 是否已装**（只读，免审批）：
   ```
   command -v skillhub && skillhub --version
   ```
   - 已装（有版本号）→ 跳到第 3 步。
   - 未装 → 第 2 步。

2. **安装 CLI（仅未装时）**——需联网，会触发主人审批：
   - 优先按官方源：先取最新安装说明 `curl -fsSL https://skillhub.cn/install/skillhub.md` 阅读；官方一键脚本通常为：
     ```
     curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash
     ```
   - 仅装 CLI 用 `... | bash -s -- --cli-only`。
   - 若上述 URL 失效，按第 1 步取回的 skillhub.md 官方说明执行。

3. **安装指定技能**——`--dir` 必须指向【运行能力盘点】里的技能目录（会触发主人审批）：
   ```
   skillhub install <技能名> --dir <技能目录>
   ```
   搜索（只读，免审批）：`skillhub search <关键词>`。

4. **安装后热加载**（免重启）：调用 `reload_skills` 工具重新扫描技能目录，告知用户已加载。

## 重要约束

- **审批是正常的**：写操作类命令（`curl|bash`、`skillhub install`）会触发主人 `#确认/#拒绝`；只读命令（`command -v`、`--version`、`search`）免审批直跑。把命令原样提交即可，主人确认后自动执行。
- 先看【运行能力盘点】确认技能目录路径，拼到 `--dir`；不要装到默认目录。
- 执行前用一句话告诉用户：要装什么、来源、可能风险。
- 若 `skillhub` 不可用或无匹配，说明并回退，不要反复重试。
- **禁止跑偏**：不要去读/搜索本插件源码（`model/`、`apps/`、`skills/`），不要 `sed`/`cat`/`grep` 插件代码，不要自己实现技能——安装失败就如实告知用户，等用户处理。

## 示例

用户：「按 https://skillhub.cn/install/skillhub.md 安装 find-skill-skillhub」
你的动作（前提：运行能力盘点显示终端 ✅已启用）：
1. `terminal({command: "command -v skillhub && skillhub --version"})` → 判断是否已装。
2. 未装则 `terminal({command: "curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash"})`（主人审批）。
3. `terminal({command: "skillhub install find-skill-skillhub --dir <技能目录>"})`（主人审批）。
4. `reload_skills({})` → 告知安装完成、已加载。
