# 鸣谢、联系与许可证

> 本文是主 README 的拆分文档。返回 [README](../README.md)。

## 🙏 鸣谢

本项目在开发过程中参考/借鉴了以下开源项目与研究的思想与实现，谨致谢意：

**框架基座**

- [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) —— 插件运行的基座框架
- [Miao-Yunzai](https://github.com/Le-niao/Yunzai-Bot) —— Yunzai 生态前身
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— OneBot 协议端（QQ 对接）

**伪人模式（核心参考）**

- **[MaiBot](https://github.com/MaiMai-with-u/MaiBot)**（MaiMai-with-u）—— 伪人模式的全程参照：对话关系链与指代消解（回复链解析、被引原文注入、防止认错说话对象）、回复必要性评分体系（强相关分/内容分/压力分/存在感惩罚/指数退避的骨架与参数）、Planner 工具调用式决策（`planner_no_tool_end`、wait 连续上限）、记忆命中作用域白名单（`_is_hit_allowed`：只允许活跃人物命中）、目标消息块防混淆措辞、表情包 `[sticker:名称]` 标记式发送、回复编排（`chat/utils`）。我们在其思路上做了自研增强：Conversation Grounding 层（三对象拆分 + 实体白名单 + 生成校验重生成）、对象纠错识别与情绪冲销、bot↔bot 闭环熔断。

**记忆与记忆体系**

- [OpenClaw](https://github.com/openclaw/openclaw) 「文件即真相」记忆设计（`MEMORY.md`/`USER.md` 人可读可编辑 + 主动召回）
- MaiBot 心意/记忆架构 —— 伪人独立记忆库的「睡眠整合」三层记忆设计（短时缓冲 → 每日整合 → 遗忘衰减）

**管理面板**

- [Guoba-Plugin](https://github.com/guoba-yunzai/guoba-plugin) —— 配置热加载与可视化面板思路（本插件自带 Web 面板）

**学术研究（GroupWorld × SelfState 设计文档引用）**

- Gratch & Marsella — *A Domain-independent Framework for Modeling Emotion* / *EMA: A Process Model of Appraisal Dynamics*（情绪评价理论 OCC/EMA）
- Steunebrink et al. — *A Formal Model of Emotions: An Analysis and Formalization of the OCC Model*
- Park et al. — [Generative Agents: Interactive Simulacra of Human Behavior](https://github.com/joonspk-research/generative-agents)（记忆流与社会仿真）
- Cai et al. — *From Triggers to Emotions: A CPM-Grounded Appraisal Multi-Agent*（情绪触发→评价多智能体）

若列举有遗漏或表述不当，欢迎指正，将及时补充修正。

---

## 📞 联系

- **QQ 群**：[960179589](https://qm.qq.com/q/960179589)
- **作者 QQ**：3891977697

问题反馈、功能建议、工具包分享欢迎进群交流。

---

## 许可证

[GPL-3.0](../LICENSE)
