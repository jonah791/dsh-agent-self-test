# dsh-agent-self-test


<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-self-test"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
</p>
自我检验闭环插件：把「猜想 → 检验 → 学习」自指引擎做成**运行时机制**（主人 2026-08-30 定调，目标接近科幻 AGI）。

## 核心循环

```
selftest_add（可证伪假设）
  → 插件在真实工具调用中被动采证（tools/result 只读通知）
  → 证据达 threshold → status=finding（⚠FINDING 浮现）
  → selftest_review 裁决：
      confirm → 生成 AGENTS.md 规则草案（把被证实的模式布线）
      refute  → 淘汰未被证实的猜想
      refine  → 改陈述/阈值，回到 active 重新采证
```

这就是「惊奇最小化」的工程化：不是被动统计（如 emotion 的命中率），而是**主动对自我行为提出可证伪猜想、让真实行为裁决**。

## 工具面

| 工具 | 作用 |
|------|------|
| `selftest_add` | 添加可证伪假设（statement + prediction + probe） |
| `selftest_list` | 查看假设库（状态/证据进度） |
| `selftest_findings` | 列出待裁决 finding |
| `selftest_review` | 裁决：confirm / refute / refine |

## 探针

| kind | 观测 | 典型假设 |
|------|------|---------|
| `tool-failure-rate` | **双向**：① 失败率 ≥ 阈值记 `violated` 证据；② 调用数达检查点（`minSamples` 整数倍）且失败率 < 阈值记 `survived`（经受住检验）证据 | 「工具 X 不可靠（失败率 ≥30%）」 |
| `read-repeat` | 同一路径在窗口内重复读取 ≥ N 次记证据 | 「我倾向于重复读同一文件（健忘信号）」 |
| `plan-before-action` | 连续工具调用突发（间隔<60s、长度≥5）前 3 分钟无 todo_write 规划 + 突发内失败 ≥1 记证据 | 「复杂多步任务不先规划会更多返工」 |
| `probe-before-action` | 实施突发（mutating ≥3）首个动作前 15 分钟无证伪探测 + 突发内失败 ≥1 记证据 | 「驱动方案前会先做最小证伪实验」（5.9 传感器） |

**tool-failure-rate 的双向语义（2026-09-11 修复）**：早期实现只在 `isError` 时采证 → 「X 可靠」这类假设**结构上无法被证实**，永远停在 active 并污染感知圈报告（实测 2 条假设证据恒 0）。现在两种证据都会采（`detail.verdict` 区分 `violated` / `survived`），finding 通知也按方向给不同文案——「假设经受住检验」与「finding 浮现」是相反的行动信号。纯判定逻辑在 `src/failure-rate.ts`（无 IO/时间依赖），离线单测 `tests/failure-rate.test.mjs`。

突发推进每工具调用只做一次（多假设不 double-count），证据广播给所有 active 的 plan-before-action 假设。

## 设计约束

- **纯观察优先**：只订阅 `tools/result` 只读通知，不注入 prompt、不干预决策（自主性铁律：信号送达，不代替决策）
- **主会话限定**：`mainSessionOnly=true` 只采证主 agent（delegationDepth 0），subagent 行为非「我」，不污染
- **finding 主动通知**：假设达阈值转 finding 时，经 `agent.send(message, 'next-step')` 主动送达主会话（无需轮询 selftest_findings）；投递走会话事件（Model-visible ⟺ logged 满足）。`setImmediate` 防 reenter，失败留日志不静默。2026-08-30 修复：直接投递 `exec.agent`（绕道 ctx.agents.get(sessionId) 会因 ID 形状不匹配找不到 agent）
- **状态持久化**：`$DSH_HOME/agent-self-test/self-test.json`（DSH_HOME 环境化，防跨重启丢）

## 配置

```yaml
plugins:
  agent-self-test:
    enabled: true
    findingThreshold: 5      # finding 触发证据阈值
    mainSessionOnly: true    # 只采证主 agent
    notifyOnFinding: true    # finding 浮现时主动通知主会话
```
