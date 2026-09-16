# 语义文档：dsh-agent-self-test（自我检验闭环 · 自指引擎）

> 版本 v0.1 · 2026-09-14 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档）
> 实现落点：`self-plugins/dsh-agent-self-test/src/index.ts`（+ 探针纯逻辑 `burst.ts` / `probe.ts` / `failure-rate.ts` / `claim-evidence.ts`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-self-test（可证伪自我假设库 + 探针自动采证 + finding 裁决与布线） |
| 主副本路径 | `self-plugins/dsh-agent-self-test/docs/semantic.md`（本文件） |
| 实现落点 | `src/index.ts`（假设库/采证管线/工具面/布线）、`src/burst.ts`（plan-before-action 状态机）、`src/probe.ts`（probe-before-action 状态机 + 工具分类）、`src/failure-rate.ts`（双向采证判定）、`src/claim-evidence.ts`（机制自述 vs 落盘实证判定） |
| 版本 | 0.3.0（git head `7d94079`） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` **行 216–218** `insert` 块：行 id `agent-agent-self-test`（:217）、name `dsh-agent-self-test`（:218）；**无 config**（全默认） |
| 状态 | **draft** |
| 测试 | `tests/burst.test.mjs`、`tests/probe.test.mjs`、`tests/failure-rate.test.mjs`、`tests/claim-evidence.test.mjs` |

## 1 · 定位与反定位

**定位**：把「猜想 → 反驳 → 学习」的自指引擎做成**运行时机制**（AGI 主线，SOUL §5.7 五环）：我写下一条**可证伪**的
自我假设（statement + prediction + probe），插件在真实工具调用中**被动采证**，证据达阈值 → `finding` →
我裁决（`confirm` 布线 / `refute` 淘汰 / `refine` 细化），`confirm` 带 `ruleDraft` 时**自动写入 AGENTS.md**。

**反定位（本文不管什么）**：
- **不替我做决策**：只「送达信号」（finding 通知 + 工具面），裁决归我（自主性铁律）
- **不注入 prompt**：不产生任何模型可见的新输入，除 findng 通知消息（走正常会话事件 → Model-visible ⟺ logged 满足）
- **不采证分身行为**：`mainSessionOnly=true` 时只看 `delegationDepth === 0`（子代理的行为不是「我」）
- **不是评测系统**：`dsh-agent-evolve` 是跨代评测（分数/账本），本插件是**单主体行为观测**
- **不是统计面板**：`dsh-agent-emotion` 统计「发生了什么」，本插件检验「我关于自己的假设是否成立」

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 假设（Hypothesis） | `{id,statement,prediction,probe,threshold,status,evidence[],createdAt,updatedAt,source?,note?,resolution?}` |
| 探针（Probe） | 声明式条件观察器：`kind` + kind 专属参数；**五种** kind（见 §4.2） |
| 证据（Evidence） | `{ts,kind,detail}`；`detail.verdict ∈ {violated, survived}` 标明**方向** |
| finding | 证据数达 `threshold` 的 active 假设（`status='finding'`）= 「该裁决了」 |
| 裁决（verdict） | `confirm`（confirmed + 布线）/ `refute`（refuted）/ `refine`（回 active、**证据清零**重新采证） |
| 布线（wire） | `confirm` 携带 `ruleDraft` 时把它写入 `AGENTS.md` 的 marker 块 |
| 突发（burst） | 连续工具调用 run，相邻间隔 < `burstGapMs`（默认 60s） |
| 误报方向 | 探针的两种错：**误报**（记了不该记的证据）/ **漏报**（该记没记）；各探针显式声明偏好哪一侧 |

## 3 · 概念模型

```
selftest_add（statement+prediction+probe+threshold）→ 状态文件 self-test.json（active）
        │
        ▼  真实工具调用发生
ctx.on('tools/result', exec, result)         ← 纯观察：只读通知，不改任何东西
        ├─ 维护滚动统计：toolStats(calls/failures)、readTimes(path→ts[])
        ├─ 若存在对应 kind 的 active 假设 → 推进该 kind 的状态机（每次调用只推一次，防 double-count）
        │     tool-failure-rate → decideFailureRateEvidence  → violated | survived
        │     read-repeat       → 窗口内同路径读取计数
        │     plan-before-action→ createBurstTracker.feed    → hadPlan=false
        │     probe-before-action→ createProbeFirstTracker.feed → 首个 mutating 前无探测
        │     claim-vs-evidence → 节流读 $DSH_HOME/life-core/life-log.jsonl → arranged vs triggered
        ├─ addEvidence：证据入假设；达阈值 → status='finding'
        └─ justFinding → notifyFinding(exec.agent)（setImmediate + agent.send('next-step')）
                                                    │
selftest_findings（工具面）←──────────────────────────┘
selftest_review(confirm, ruleDraft) → wireRuleToAgents → AGENTS.md marker 块（原子写 + 备份）
```

不变量（invariants）：
1. **I1 被动观察**：只订阅 `tools/result`（emit 只读通知）——不拦截、不修改 `result`、不注入 prompt（可测量：grep `ctx.on` 只有 `tools/result` 一处，且回调内无对 exec/result 的写操作）。
2. **I2 主会话限定**：`config.mainSessionOnly && !isMainAgent(exec.agent)` → 直接 return（`index.ts:310`）。
3. **I3 阈值即状态转换**：`evidence.length >= threshold` 且当前 `active` → `finding`，且只转一次（`index.ts:264`）。
4. **I4 confirm 只对 finding**：非 finding 调 `confirm` 返回 `{ok:false,error:'only finding can be confirmed (current: X)'}`（`index.ts:609`）。
5. **I5 refine 清空证据**：`h.evidence = []`（重新采证，`index.ts:629`）——防止旧证据把新陈述推向 finding。
6. **I6 布线原子且可回滚**：先备份 `<DSH_HOME>/agent-self-test/backups/AGENTS.md.bak-<ts>`，再 `tmp + rename`（`index.ts:222-245`）；marker 块已存在则**整体替换**，不追加第二块。
7. **I7 单突发单证据**：同一突发最多记一条（`evidenced` 标志，`burst.ts:75` / `probe.ts:165`）。
8. **I8 观测失明不反噬**：读 life-log 失败返回 `null`（不抛、不采证、不影响主流程，`index.ts:138`）；状态写失败吞错。

## 4 · 契约

### 4.1 数据结构 / 文件 / 服务

| 名称 | 路径 / 形状 | 语义 |
|------|------------|------|
| 状态文件 | `$DSH_HOME/agent-self-test/self-test.json` → `{hypotheses: Hypothesis[]}` | 全量读写（每次工具调用 `loadState`）；坏 JSON → 重置为空（**不抛**） |
| 布线目标 | `<workspaceDir>/AGENTS.md`（`workspaceDir` 缺省 `process.cwd()`） | marker 块 `<!-- dsh-agent-self-test:start -->` … `<!-- dsh-agent-self-test:end -->` |
| 备份 | `$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ISO>` | 每次布线前 best-effort 写（失败不阻断布线） |
| life-log（**读**） | `$DSH_HOME/life-core/life-log.jsonl` | 仅 `claim-vs-evidence` 探针读；按 `claimCheckIntervalMs` 节流（默认 5 分钟） |

### 4.2 裁决（纯函数优先）

| 探针 kind | 纯函数 / 模块 | 证据条件 | 默认参数 | 误报偏好 |
|-----------|--------------|---------|---------|---------|
| `tool-failure-rate` | `decideFailureRateEvidence`（`failure-rate.ts:70`） | `isError && rate ≥ threshold` → `violated`；`calls % minSamples === 0 && rate < threshold` → `survived` | `threshold=0.3`、`minSamples=20` | 违规即记账（宁可多记） |
| `read-repeat` | 内联（`index.ts:386`） | 窗口内同路径读取次数 ≥ `repeatCount` | `windowMs=10min`、`repeatCount=2` | 重复读=健忘信号 |
| `plan-before-action` | `createBurstTracker`（`burst.ts:59`） | 突发 `calls ≥ minSteps` **且** `hadPlan=false` **且** `failures ≥ 1` | `burstGapMs=60s`、`minSteps=5`、`planWindowMs=3min` | 只记「没规划 **且** 撞墙」 |
| `probe-before-action` | `createProbeFirstTracker`（`probe.ts:143`） | 突发 `actions(minating) ≥ minActions` **且** 首个 mutating 前 `probeWindowMs` 内零探测 **且** `failures ≥ 1` | `burstGapMs=60s`、`minActions=3`、`probeWindowMs=15min` | 拿不准分类 → `neutral`（宁可漏判不误判） |
| `claim-vs-evidence` | `countLifeCycleClaims` + `decideClaimEvidence`（`claim-evidence.ts:96/117`） | `arranged ≥ minArranged` 且 `triggered === 0` → `violated`（假活）；`triggered ≥ 1` → `survived` | `windowMs=6h`、`minArranged=5`、检查间隔 5min | 自述密集而实证为零才算 |

`selftest_review` 裁决表：

| 输入状态 | verdict | 效果 | 语义依据 |
|---------|---------|------|---------|
| `status='finding'` | `confirm` | `confirmed` + `resolution` + 若非空 `ruleDraft` → 布线 AGENTS.md | 五环最后一环 |
| 任意 | `refute` | `refuted`（不再采证） | 淘汰未被证实的猜想 |
| `status='finding'` | `confirm`（无 ruleDraft） | 只改状态，不写文件 | 布线是可选的 |
| `status≠'finding'` | `confirm` | **拒绝**（`ok:false`） | I4 |

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:216-218`（行 id `agent-agent-self-test`） | web 启动 |
| inject 声明 | `src/index.ts:31` `inject = ['tools','agents']` | 激活门 |
| 采证入口（**唯一订阅**） | `src/index.ts:308 ctx.on('tools/result', (exec, result) => …)` | 每次工具调用后 |
| finding 通知 | `src/index.ts:273 notifyFinding(agent, h)` → `setImmediate(() => agent.send(msg,'next-step',true))`（`:297-304`） | 阈值刚达成时 |
| 布线 | `src/index.ts:222 wireRuleToAgents(ruleDraft)` ← `selftest_review` `:620` | confirm + ruleDraft |
| `selftest_add` | `src/index.ts:443 ctx.tools.register(defineTool(...))` | 工具面 |
| `selftest_list` | `src/index.ts:515` | 同上 |
| `selftest_findings` | `src/index.ts:551` | 同上 |
| `selftest_review` | `src/index.ts:579` | 同上 |
| 生命周期 | `src/index.ts:637 ctx.effect(() => () => {})`（`ctx.on` 由 cordis 自动释放） | mount / unmount |
| 落盘产物 | `$DSH_HOME/agent-self-test/self-test.json`、`$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ts>`、`<workspace>/AGENTS.md`（marker 块） | — |
| 消费方 | 我（裁决 finding）；`AGENTS.md` 注入层（规则生效）；`dsh-agent-evolve`（读假设库判「有 active 假设但证据 0」） | — |
| 测试 | `tests/burst.test.mjs`、`tests/probe.test.mjs`、`tests/failure-rate.test.mjs`、`tests/claim-evidence.test.mjs` | `pnpm test` |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`selftest_review(confirm, ruleDraft)` **会写工作区 AGENTS.md**（我能改自己的规则文件）——marker 块+备份+原子写是安全网，但**误写仍会立即影响下一个 turn 的行为**（热重载注入）。
- **不越界清单**：不写会话事件（除 finding 通知走正常 send）；不改工具结果；不采证子代理；不自动裁决（`confirm` 必须由我调用）。
- **失败面**：
  - 状态文件损坏 → 重置为空（**放行 + 静默**）：假设库丢失无告警——见 U2。
  - 布线失败（AGENTS.md 不存在/不可写） → 返回 `{wired:false, error}`，**状态仍标 confirmed**（裁决与布线解耦）。
  - 备份失败 → 注释明确「不阻断布线」（checkpoint 是主安全网）。
  - finding 通知失败 → `console.log` 留痕，不重试（**已知缺口**：可能丢一次通知，`selftest_findings` 仍可拉取）。
  - life-log 不可读 → 返回 null，不采证、不报错。
  - 探针分类的**启发式**（`PROBE_TOOLS` 静态集合 + `SHELL_PROBE_RE`/`SHELL_MUTATE_RE` 正则）会漏判（未列出的工具归 `neutral`）——`probe-before-action` 的漏报方向是**漏报违规**（保守）。

## 6 · 与既有机制的关系

| 机制 | 关系与顺序约束 |
|------|--------------|
| AGENTS.md §5.7（自我进化闭环） | 本插件是五环（猜想→采证→finding→裁决→布线）的**载体**；布线不再靠临场自觉 |
| §5.9（行动前验证纪律） | `probe-before-action` 探针 = §5.9 的**配套传感器**（当时声明的「采证缺口」已由 `src/probe.ts` 填补） |
| §5.17（防线跳过分支纪律） | `claim-vs-evidence` 探针 = 感知圈停摆事故（29h 零真实圈）的**配套传感器**（自述密集而实证为零 = 假活） |
| §5.8（记忆检索纪律） | `plan-before-action` 探针检验「复杂多步任务先 todo_write」这条纪律是否真被执行 |
| §5.5（规则记录纪律） | 布线目标就是 AGENTS.md 本体；`AGENTS.md` 末尾的 `<!-- dsh-agent-self-test:start -->` 块即本插件写入物的**物证** |
| 技能 `self-test-loop` | 方法论（接 finding → 裁决 → 当场布线）在本插件之上；本插件提供原语 |
| `dsh-agent-evolve` | 读假设库状态做「进化断点诊断」（active 但证据 0 曾是典型断点——已由双向采证修复） |

## 7 · 可证伪验收清单

| # | 可证伪命题 | 证据（命令/文件/日志行） | 状态 |
|---|-----------|------------------------|------|
| A1 | 运行中的 web 加载的是当前构建 | `lib/index.js` mtime 2026-09-12 22:03:23 **早于** web 启动 2026-09-14 10:05:47 | ✓ 已实测 |
| A2 | 五环真的跑过（不是空机制） | `self-test.json`：16 条假设 = confirmed 9 / refuted 6 / active 1（mtime 2026-09-14 10:13） | ✓ 已实测 |
| A3 | 布线物证存在 | `AGENTS.md` 含 `<!-- dsh-agent-self-test:start -->` … `end` 块（内容为「机制异常先取证」规则） | ✓ 已实测 |
| A4 | 四种探针的判定与边界 | `node --test tests/*.test.mjs`（4 套件） | 待验收（未在本轮执行） |
| A5 | 工具可答：`selftest_findings` 返回当前 finding 数 | 调 `selftest_findings` → 与 `self-test.json` 中 `status='finding'` 条数一致 | 待验收 |
| A6 | 采证只作用于主会话 | 让子代理触发工具 → `self-test.json` 证据数**不增** | 待验收 |
| A7 | confirm 布线可回滚 | 布线后 `ls $DSH_HOME/agent-self-test/backups/` 出现 `.bak-<ts>`，内容为布线前的 AGENTS.md | 待验收 |
| A8 | finding 通知真的落到会话 | 造一条阈值 1 的假设 + 触发一次匹配工具调用 → 会话出现 `[self-test] …` 消息 | 待验收 |
| A9 | 双证据方向区分 | `self-test.json` 中 canonical `detail.verdict` 同时出现 `violated` 与 `survived`（tool-failure-rate 侧 survived、probe-before-action 侧 violated） | ✓ 已实测 |
| A10 | **假设极性生效**：`selftest_list` 对每条假设给出方向判定，并标出「状态=confirmed 但方向=反对/混杂」的存量误判 | 修复前 `polaritySuspects=7`（6 反对 + 1 混杂，逐条 id 见 §9 记录）；7 条处置后归零 | ✓ 已实测 |
| A11 | **裁决护栏 + 返回值无损**：方向相悖时 `selftest_review` 返回 `polarityWarning`（不阻断）；可选键**不存在**而非 `undefined` | 线上两次 refine 返回 `裁决完成：…（证据 0 条；方向 mixed）`，无 `invalid output: value is not lossless JSON` | ✓ 已实测 |
| A12 | 五族探针载荷契约统一（`verdict` 字段 + 词表 `violated`/`survived`） | `node --test "tests/*.test.mjs"` → `# tests 68 / # pass 68 / # fail 0`（含 `tests/polarity.test.mjs` 的「载荷契约」两例） | ✓ 已实测 |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`。**纯逻辑层**（可离线单测，`dsh-plugin-testability` 模式）：`burst.ts` / `probe.ts` / `failure-rate.ts` / `claim-evidence.ts`。
- **同语义副本（I1）**：无。**相邻但不同主**：`dsh-agent-emotion` 也统计工具调用成功率，但语义不同（统计「发生了什么」 vs 检验「关于自己的假设是否成立」），两者**不互为副本**。
- **未实现 / 未验证部分（显式标注）**：
  1. `PROBE_TOOLS` / `MUTATING_TOOLS` 是**静态清单**（含 WQ / 安全 / ComfyUI 等工具名）——工具面变化后清单会腐化；无自检机制（未验证）。
  2. `evidence` 数组**无上限**（`addEvidence` 只 push）——长期运行的假设会无限增长（当前 16 条假设文件 41.5KB，尚可）。
  3. 通知失败不重试（§5 失败面）。
  4. `read-repeat` 的 `readTimes` 只留最近 20 次且**仅内存**：重启即失忆。
  5. **`plan-before-action` 没有对照组**（2026-09-17 补记，见 U6）：它只记录「无规划 + ≥1 失败」这一个象限，合规突发不产证据 ⇒ 条件型主张（「不规划 ⇒ 更易失败」）在结构上**不可判**。未补对照组前，该类假设不得 confirm。
- **生效判据**（改了代码后怎么证明真的生效）：
  1. **产物 vs 进程**：`lib/index.js` mtime 早于 web 进程启动时间（当前 09-12 22:03:23 < 09-14 10:05:47 ✓ live）。**改了探针代码必须重建 + 重启**才生效。
  2. **落盘物证**：`$DSH_HOME/agent-self-test/self-test.json` 的 mtime 前进（每次采证/裁决都写）；`backups/` 出现新 `.bak-*`（布线）。
  3. **工具可答**：`selftest_list` / `selftest_findings` 返回与状态文件一致的内容——**工具面即自证**（`selftest_list` 的渲染会显示证据数/阈值）。
- **回退**：
  - 组合面：`plugin_stop dsh-agent-self-test`（patch `disabled: true` + 预检 + 哨兵重启）——采证停止，**已有假设与 AGENTS.md 布线块保留**。
  - 布线面（**最重要**）：`confirm` 写入的规则块污染行为时——① 手工删除 `AGENTS.md` 的 marker 块，或 ② 从 `$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ts>` 恢复，或 ③ `checkpoint_restore`（存档含 AGENTS.md）。
  - 代码面：`git revert <commit>`（head `7d94079`）+ `pnpm build`。
  - 数据面：`self-test.json` 可备份后编辑（把 `finding` 改回 `active` 或 `refuted`）；删除 = 假设库清空（**不可逆**，删前 `copy` 一份）。

## 9 · 实践修订记录

**2026-09-14 补课：本插件此前无语义文档（可维护性工程）**

- 语义**被确认**：
  - 五环真的闭合：`self-test.json` 有 9 confirmed / 6 refuted，且 `AGENTS.md` 末尾存在本插件写入的 marker 块——「布线」环节有**物证**，不是设计承诺。
  - 「纯观察优先」成立：`ctx.on` 全文件只有 `tools/result` 一处。
- 语义**被补充**（本文首次写清的部分）：
  - **`tool-failure-rate` 是双向的**（`violated` / `survived`）——2026-09-11 修复的采证不对称；README 已记，但语义文档此前缺失，导致「证据 0 的 active 假设」被误读为耐心问题而非传感器失明。
  - **`confirm` 无 `ruleDraft` 时不布线**（只改状态）——「裁决」与「布线」是两个可选步骤，五环的最后一环**不是自动的**。
  - **`refine` 清空证据**是刻意的（I5）——否则旧证据会立刻把新陈述推回 finding。
- 语义**被修正**：无（未发现实现与文档冲突；README 的探针表已与实现一致）。
- 教训（同时回写技能 `semantic-doc-first`）：**「传感器失明」是一种必须写进文档的失效模式**——机制「在运行」不等于「能采到证」；语义文档的 §5 失败面必须显式写出每个探针**偏好哪一侧误判**（本插件四个探针的偏好各不相同，只有源码注释里有）。

**2026-09-17 实践回修：探针极性缺失（任务 `t-56b052fb`）**

- 语义**被修正**（文档与实现都缺的那一层）：
  - 本文原先把「证据方向」只当作**探针的属性**（`detail.verdict`），**漏掉了假设属性 `polarity`**——同一份 `violated` 证据对「我会做 X」是**反对**、对「我倾向做 X」（自省缺陷型）是**支持**。新增 `src/polarity.ts` 作为唯一真源（`DEFAULT_POLARITY` / `LEGACY_UNLABELED_VERDICT` / `readEventVerdict` / `resolvePolarity` / `computeDirection` / `contradictsDirection`），`ProbeKind` 定义也移入该模块（§5.22 判据单一真源）。
  - 五族探针载荷统一为 canonical `detail.verdict`：`probe-before-action` 由 `kind:'violation'` 改名（旧字段名与旧词形 `violation` 由 `readEventVerdict` 兼容读取）；`read-repeat` / `plan-before-action` 由**完全不写**改为显式 `verdict:'violated'`。
  - 四个消费方（`notifyFinding` / `selftest_findings` / `selftest_list` / `selftest_review`）改为共用 `computeDirection`；`selftest_list` 新增**存量极性体检**（`polaritySuspects` = confirmed 但方向为反对/混杂），取代一次性排障脚本（§5.22 规则 6：排障即升级工具）。
  - `selftest_add` 新增 `polarity` 参数并在写入时**物化默认值**；`selftest_review` 新增 `polarity` 参数（refine 时校正极性）。
- 语义**被确认**：五环第三环「finding」的正确读法是「**证据够了**」而不是「假设被证实」——原 `selftest_findings` 描述与通知文案都写成后者，实测导致 7 条「我会先做 X」型假设方向读反（6 条被违规证据判成 confirmed + 1 条混杂）。
- 实测处置（一次性裁决留痕）：`h-mtfgltcj-2` / `h-mtfj0qnc-1` / `h-mtisdxq1-1` / `h-mtzit9kb-1` / `h-mu0kkke2-1` / `h-mu1atc6v-1` → **refute**（前两条是条件型主张、无对照组不可判；中间三条是「我会先探测」被违规证据证伪；末条是「序位判据」行为主张被证伪——**规则保留、行为主张淘汰**）；`h-mu0qvlm1-2` / `h-mu3rd53i-1` → **refine**（去掉不可证伪措辞、加量化判据、清旧证据重采）；重开一条声明极性的新假设 `h-mu4djfqf-1`。
- 事故与教训（同时回写技能 `dsh-plugin-pitfalls`）：
  1. **「方向住在人脑子里」是一种静默失真**：三族探针不写方向字段，方向靠「这类探针只在违规时发射」的隐式约定 ⇒ 任何消费方都得自己猜，猜错就把「被证伪」读成「被证实」（本条已证）。
  2. **可选键绝不可写成 `x ?? undefined`**：`JSON.parse(JSON.stringify(v))` 会丢掉该键 ⇒ 与原值不等 ⇒ 宿主判 `invalid output: value is not lossless JSON`。要点：**execute 的副作用已落盘，只是返回值被拒**（本次 6 条裁决靠这一事实落地，靠事后 `selftest_list` 复核确认，而非假定）。

## 10 · 未决问题

- **U1 探针工具清单的自维护**：`PROBE_TOOLS`/`MUTATING_TOOLS` 靠手维护（新增工具后不会自动归类）。倾向：加一条 `claim-vs-evidence` 式元假设——「未分类的工具占比 > X%」即提示清单腐化。
- **U2 状态文件损坏静默重置**：与「坏数据放行 + 落 issue」纪律不符。倾向：重置前把坏文件另存为 `self-test.json.corrupt-<ts>` 并记 warn。
- **U3 evidence 数组无上限**：倾向保留最近 N 条 + 计数（裁决只需条数与方向，不需全部明细）。
- **U4 finding 通知失败无重试**：是否改为「落盘待通知队列 + 启动补发」（与 telegram outbox 同款）？
- **U5 `workspaceDir` 缺省 `process.cwd()`**：web 进程 cwd 是工作区，但 watch/sentinel 类场景下 cwd 可能不同——是否需要像其他插件一样显式配置？
- **U6 `plan-before-action` 缺对照组**（2026-09-17 新增）：本族只有违规路径 ⇒ 条件型/相关型主张结构上不可判（实测已有 2 条假设因此被证伪）。倾向：给 `src/burst.ts` 补 survived 路径（合规突发且零失败 ⇒ 记 `verdict:'survived'`，同 `probe.ts` 2026-09-17 所做），补齐后重开该类检验。
