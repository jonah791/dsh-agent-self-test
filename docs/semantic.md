# 语义文档：dsh-agent-self-test（自我检验闭环 · 自指引擎）

> 版本 v0.2 · 2026-09-14 首版 / 2026-09-22 复核回写 · 作者：爱丽丝 · 状态：**draft**
> 开发方式：语义文档优先（本份是 2026-09-14 可维护性工程的**补课**文档；2026-09-22 按 D3「实现比文档新」复核回写）
> 实现落点：`self-plugins/dsh-agent-self-test/src/index.ts`（+ 纯逻辑 `burst.ts` / `probe.ts` / `failure-rate.ts` / `claim-evidence.ts` / `polarity.ts` / `wiring.ts` / `cluster.ts`）

| 项 | 值 |
|----|----|
| 能力名 | dsh-agent-self-test（可证伪自我假设库 + 探针自动采证 + finding 裁决与布线） |
| 主副本路径 | `self-plugins/dsh-agent-self-test/docs/semantic.md`（本文件） |
| 实现落点 | `src/index.ts`（假设库/采证管线/工具面/布线）、`src/burst.ts`（plan-before-action 状态机）、`src/probe.ts`（probe-before-action 状态机 + 工具分类）、`src/failure-rate.ts`（双向采证判定）、`src/claim-evidence.ts`（机制自述 vs 落盘实证判定）、`src/polarity.ts`（**极性/方向/倾向度唯一真源**）、`src/wiring.ts`（**布线 upsert + 字节预算守卫**）、`src/cluster.ts`（**同族重开簇检测**） |
| 版本 | 0.6.0（**工作区**；已提交 head `468f867` = v0.5.1。0.6.0 改动尚在工作区未提交，但**已构建并 live**——判据见 §9 2026-09-22 追补） |
| 挂载位置 | `.dsh/profiles/web/cordis.patch.yml` **行 216–218** `insert` 块：行 id `agent-agent-self-test`（:217）、name `dsh-agent-self-test`（:218）；**patch 里无 config** ⇒ 全部走默认值（配置项表见 §4.1） |
| 状态 | **draft** |
| 测试 | `tests/burst.test.mjs`、`tests/probe.test.mjs`、`tests/failure-rate.test.mjs`、`tests/claim-evidence.test.mjs`、`tests/polarity.test.mjs`、`tests/wiring.test.mjs`、`tests/cluster.test.mjs`（7 套件；实测读数见 §7 A14） |

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
| 布线（wire） | `confirm` 携带 `ruleDraft` 时把它**合并**写入 `AGENTS.md` 的 marker 块（`src/wiring.ts`）。语义是 **upsert（只增不减）**：同规则归一化后已包含 ⇒ 幂等跳过；新规则 ⇒ 追加块尾，既有条目**一字不动**；写入前过字节预算裁决（超限则拒写）。四态回报 `added` / `exists` / `rejected` / `error` |
| 收敛提示（cluster note） | `selftest_add` **新建之前**检测同族是否已成堆（同族**终态**假设 ≥ `CLUSTER_THRESHOLD`=3）⇒ 随返回值/render 送达三选一提示（refine 旧判据 / 承认不可测 / 转机制承载）。**只送达信号，不阻断**（§2.4 禁自动决策；治的是「同题反复重开」，不是「被证伪」） |
| 倾向度（lean） | 方向为 `mixed` 时的**分辨率**分档：支持占比 ≥ `LEAN_THRESHOLD`=0.8 ⇒ `lean-support`；≤0.2 ⇒ `lean-refute`；其间 `balanced`；无方向证据 `none`。**只加信息、不改语义**——让 7:1 与 1:1 不再长得一样 |
| 突发（burst） | 连续工具调用 run，相邻间隔 < `burstGapMs`（默认 60s） |
| 误报方向 | 探针的两种错：**误报**（记了不该记的证据）/ **漏报**（该记没记）；各探针显式声明偏好哪一侧 |

## 3 · 概念模型

```
selftest_add（statement+prediction+probe+threshold）→ detectCluster（同族已成堆 ⇒ 附 clusterNote 提示，不阻断）
        │                                          → 状态文件 self-test.json（active）
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
selftest_review(confirm, ruleDraft) → wireRuleToAgents → wiring.ts：upsertRuleBlock（同规则幂等 / 新规则追加块尾）
                                     → checkBudget（超 agentsMaxBytes ⇒ rejected，拒写上报）→ 备份 + tmp/rename 原子写
```

不变量（invariants）：
1. **I1 被动观察**：只订阅 `tools/result`（emit 只读通知）——不拦截、不修改 `result`、不注入 prompt（可测量：grep `ctx.on` 只有 `tools/result` 一处，且回调内无对 exec/result 的写操作）。
2. **I2 主会话限定**：`config.mainSessionOnly && !isMainAgent(exec.agent)` → 直接 return（`index.ts:345`）。
3. **I3 阈值即状态转换**：`evidence.length >= threshold` 且当前 `active` → `finding`，且只转一次（`index.ts:301-302`）。
4. **I4 confirm 只对 finding**：非 finding 调 `confirm` 返回 `{ok:false,error:'only finding can be confirmed (current: X)'}`（`index.ts:717`）。
5. **I5 refine 清空证据**：`h.evidence = []`（重新采证，`index.ts:754`）——防止旧证据把新陈述推向 finding。
6. **I6 布线是 upsert（只增不减）+ 预算守卫，且原子可回滚**：`upsertRuleBlock`（同规则归一化后已包含 ⇒ `exists`，**一字不写**；新规则 ⇒ 追加块尾，既有条目一字不动）→ `checkBudget`（写入后字节 > `agentsMaxBytes` ⇒ `rejected`，**拒绝写盘**并回报 `bytes`/`headroom`，绝不静默截断尾部）→ 先备份 `<DSH_HOME>/agent-self-test/backups/AGENTS.md.bak-<ts>` 再 `tmp + rename`（`index.ts:243-283` + `src/wiring.ts`）。
   ⚠ **旧语义（2026-09-17 前，已废除）**是 `full.replace(/start[\s\S]*end/, block)` **整块替换**——它隐含假设「块里只有一条规则」，而块是**累积**的 ⇒ 第二次 confirm 抹掉第一次的规则（2026-09-16 / 09-17 各丢一条，只有字节数反降 65,151→64,795 才暴露）。见 §9 2026-09-22 复核回写。
7. **I7 单突发单证据**：同一突发最多记一条（`evidenced` 标志，`burst.ts:88/101` / `probe.ts:194/204`）。
8. **I8 观测失明不反噬**：读 life-log 失败返回 `null`（不抛、不采证、不影响主流程，`index.ts:152`）；状态写失败吞错。
9. **I9 倾向度不改语义（向后兼容）**：`computeDirection` 的 `lean` 只是**附加信息**；`contradictsDirection(action, direction, lean?)` 在 `lean` 缺省时行为与旧版**完全一致**（`polarity.ts:192-196`）。
10. **I10 收敛提示不阻断**：`detectCluster` 是**纯函数**（无 IO、无时间依赖），其结论只进 `selftest_add` 的返回值与 render 文案——**不影响任何写入决策**（假设照常创建）；且**必须在 `push` 之前计算**，否则会把刚建的这条算进簇里（`index.ts:561`）。

## 4 · 契约

### 4.1 数据结构 / 文件 / 服务

| 名称 | 路径 / 形状 | 语义 |
|------|------------|------|
| 状态文件 | `$DSH_HOME/agent-self-test/self-test.json` → `{hypotheses: Hypothesis[]}` | 全量读写（每次工具调用 `loadState`）；坏 JSON → 重置为空（**不抛**） |
| 布线目标 | `<workspaceDir>/AGENTS.md`（`workspaceDir` 缺省 `process.cwd()`） | marker 块 `<!-- dsh-agent-self-test:start -->` … `<!-- dsh-agent-self-test:end -->`；marker 字面量**单一真源**在 `src/wiring.ts`（`MARKER_START` / `MARKER_END`，写入与解析共用，防两处各写一份字面量）；块内语义 = **upsert 累积**（见 §3 I6） |
| 备份 | `$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ISO>` | 每次布线前 best-effort 写（失败不阻断布线） |
| life-log（**读**） | `$DSH_HOME/life-core/life-log.jsonl` | 仅 `claim-vs-evidence` 探针读；按 `claimCheckIntervalMs` 节流（默认 5 分钟） |

**插件配置（`Config`，`index.ts:37-65`；patch 未配 ⇒ 全默认）**：

| 键 | 默认 | 语义 |
|----|------|------|
| `enabled` | `true` | 插件开关 |
| `dataDir?` | — | 状态文件目录（缺省 `$DSH_HOME/agent-self-test`） |
| `findingThreshold` | `5` | finding 触发阈值（证据条数） |
| `mainSessionOnly` | `true` | 只统计主 agent（I2） |
| `notifyOnFinding` | `true` | finding 浮现时主动通知主会话（信号送达，裁决归爱丽丝） |
| `workspaceDir?` | — | 布线目标工作区根（缺省 `process.cwd()`） |
| `agentsMaxBytes` | `65000` | **AGENTS.md 写入字节预算**（注入硬上限实测 ~65536，超限从尾部静默截断）——超限**拒写并回报**（§5 失败面） |

### 4.2 裁决（纯函数优先）

| 探针 kind | 纯函数 / 模块 | 证据条件 | 默认参数 | 误报偏好 |
|-----------|--------------|---------|---------|---------|
| `tool-failure-rate` | `decideFailureRateEvidence`（`failure-rate.ts:70`） | `isError && rate ≥ threshold` → `violated`；`calls % minSamples === 0 && rate < threshold` → `survived` | `threshold=0.3`、`minSamples=20` | 违规即记账（宁可多记） |
| `read-repeat` | 内联（`index.ts:421-432`） | 窗口内同路径读取次数 ≥ `repeatCount` | `windowMs=10min`、`repeatCount=2` | 重复读=健忘信号 |
| `plan-before-action` | `createBurstTracker`（`burst.ts:59`） | 突发 `calls ≥ minSteps` **且** `hadPlan=false` **且** `failures ≥ 1` | `burstGapMs=60s`、`minSteps=5`、`planWindowMs=3min` | 只记「没规划 **且** 撞墙」 |
| `probe-before-action` | `createProbeFirstTracker`（`probe.ts:143`） | 突发 `actions(minating) ≥ minActions` **且** 首个 mutating 前 `probeWindowMs` 内零探测 **且** `failures ≥ 1` | `burstGapMs=60s`、`minActions=3`、`probeWindowMs=15min` | 拿不准分类 → `neutral`（宁可漏判不误判） |
| `claim-vs-evidence` | `countLifeCycleClaims` + `decideClaimEvidence`（`claim-evidence.ts:96/117`） | `arranged ≥ minArranged` 且 `triggered === 0` → `violated`（假活）；`triggered ≥ 1` → `survived` | `windowMs=6h`、`minArranged=5`、检查间隔 5min | 自述密集而实证为零才算 |

**方向 / 极性 / 倾向度（`src/polarity.ts` —— 唯一真源，`§5.22 判据单一真源`）**：

- `computeDirection(evidence, probe) → { direction, lean, ratio, support, refute, legacyAssumed, unknown, polarity, text }`
  - `direction`：`support`（证据指向成立）/ `refute`（指向不成立）/ `mixed`（两向都有）/ `unknown`（无方向信息、**不猜**）
  - **极性的作用**：同一份 `violated` 证据，对 `violation-refutes` 型主张（「我会做 X」）是**反对**，对 `violation-supports` 型（自省缺陷型「我倾向做 X」）是**支持**（`DEFAULT_POLARITY` 五族缺省：read-repeat 为 supports，其余四族 refutes）
  - **`lean` 倾向度（2026-09-20 新增）**：`mixed` 时按支持占比分档（阈值 `LEAN_THRESHOLD = 0.8`）——`lean-support` / `lean-refute` / `balanced` / `none`。**只加信息、不改语义**（I9）
- **存量极性体检（`selftest_list.polaritySuspects`，`index.ts:618-627`）**：判据 = `confirmed && direction !== 'support' && lean !== 'lean-support'`（⚠ **2026-09-20 细化**：方向混杂但**倾向支持**（如 7:1）不再计入——那类是「还差一条反例」（分辨率不足），不是「方向读反」；旧判据实测误报两条）。`selftest_list` 的行内也会显示 `·倾向支持 7:1` 这类倾向度
- **裁决护栏（`selftest_review`）**：动作与方向相悖时返回 `polarityWarning`（**只提示不阻断**，§2.1）；`lean` 参与判定（`contradictsDirection` 接受可选 `lean`）——倾向支持时 `confirm` 不再报警

`selftest_review` 裁决表：

| 输入状态 | verdict | 效果 | 语义依据 |
|---------|---------|------|---------|
| `status='finding'` | `confirm` | `confirmed` + `resolution` + 若非空 `ruleDraft` → 布线 AGENTS.md（四态回报 `added`/`exists`/`rejected`/`error`） | 五环最后一环 |
| 任意 | `refute` | `refuted`（不再采证） | 淘汰未被证实的猜想 |
| `status='finding'` | `confirm`（无 ruleDraft） | 只改状态，不写文件 | 布线是可选的 |
| `status≠'finding'` | `confirm` | **拒绝**（`ok:false`） | I4 |

### 4.3 调用点清单 `[MUST]`

> **行号锚点**：下表行号以 **2026-09-22 工作区**（v0.6.0）为准；`git log -1 --format=%h` = head `468f867`（v0.5.1）+ 未提交改动。改动 `src/index.ts` 后必须重新核对本表（行号漂移是最容易被漏掉的文档腐化）。

| 调用方 | 调用点（文件:符号 / 行号） | 时机 |
|-------|--------------------------|------|
| web profile 组合 | `.dsh/profiles/web/cordis.patch.yml:216-218`（行 id `agent-agent-self-test`） | web 启动 |
| inject 声明 | `src/index.ts:35` `inject = ['tools','agents']` | 激活门 |
| 采证入口（**唯一订阅**） | `src/index.ts:343 ctx.on('tools/result', (exec, result) => …)` | 每次工具调用后 |
| finding 通知 | `src/index.ts:310 notifyFinding(agent, h)` → `setImmediate(() => agent.send(msg,'next-step',true))`；调用点 `:476`（`for (const h of justFinding) notifyFinding(exec.agent, h)`） | 阈值刚达成时 |
| 布线（宿主侧） | `src/index.ts:243 wireRuleToAgents(ruleDraft)` ← `selftest_review` `:745` | confirm + ruleDraft |
| 布线（纯函数侧） | `src/wiring.ts`：`normalizeRule` / `upsertRuleBlock` / `checkBudget` / `extractBlockInner` / `spliceBlock` / `MARKER_START` / `MARKER_END` ← 被 `index.ts:251-257` 与 `tests/wiring.test.mjs` 调用 | 每次 confirm 布线 |
| 收敛提示 | `src/cluster.ts detectCluster(...)` ← `selftest_add` `:561`（**在 `push` 之前**）+ render 追加 `clusterNote` | 每次 `selftest_add` |
| 方向/极性/倾向度 | `src/polarity.ts`：`computeDirection` / `contradictsDirection` / `resolvePolarity` / `readEventVerdict` / `DEFAULT_POLARITY` ← 四个消费方（`notifyFinding` / `selftest_findings` / `selftest_list` / `selftest_review`） | 每次裁决 / 列表 / 通知 |
| `selftest_add` | `src/index.ts:481 ctx.tools.register(defineTool(...))` | 工具面 |
| `selftest_list` | `src/index.ts:568` | 同上 |
| `selftest_findings` | `src/index.ts:633` | 同上 |
| `selftest_review` | `src/index.ts:668` | 同上 |
| 生命周期 | `src/index.ts:793 ctx.effect(() => () => {})`（`ctx.on` 由 cordis 自动释放） | mount / unmount |
| 落盘产物 | `$DSH_HOME/agent-self-test/self-test.json`、`$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ts>`、`<workspace>/AGENTS.md`（marker 块） | — |
| 消费方 | 我（裁决 finding）；`AGENTS.md` 注入层（规则生效）；`dsh-agent-evolve`（读假设库判「有 active 假设但证据 0」） | — |
| 测试 | `tests/burst.test.mjs`、`tests/probe.test.mjs`、`tests/failure-rate.test.mjs`、`tests/claim-evidence.test.mjs`、`tests/polarity.test.mjs`、`tests/wiring.test.mjs`、`tests/cluster.test.mjs`（7 套件） | `pnpm test`（等价：`node --test "tests/*.test.mjs"`） |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：`selftest_review(confirm, ruleDraft)` **会写工作区 AGENTS.md**（我能改自己的规则文件）——marker 块+备份+原子写是安全网，但**误写仍会立即影响下一个 turn 的行为**（热重载注入）。
- **不越界清单**：不写会话事件（除 finding 通知走正常 send）；不改工具结果；不采证子代理；不自动裁决（`confirm` 必须由我调用）；**不因收敛提示改变写入**（提示只送达，I10）。
- **失败面**：
  - 状态文件损坏 → 重置为空（**放行 + 静默**）：假设库丢失无告警——见 U2。
  - 布线**四态**（2026-09-17 起，`index.ts:243-283`）：`added`（已新增，附 `bytes`/`headroom`）/ `exists`（同规则已在块内 ⇒ **幂等跳过、一字不写**——这让「重复 confirm」变得无害）/ `rejected`（写入后超 `agentsMaxBytes` ⇒ **拒写并回报字节与余量**，绝不静默截断尾部）/ `error`（AGENTS.md 不存在或读写失败）。**四种情形状态都仍标 confirmed**（裁决与布线解耦）；四态在 `selftest_review` 的 render 里**当场可见**（「可见面」纪律：默默没写 = 又一次静默失败）。
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
| A1 | 运行中的 web 加载的是当前构建 | `lib/index.js` mtime 2026-09-20 20:24:18 **早于** web 启动 2026-09-22 12:29:33（`plugin_boot_status` 读出：进程启动 1790051373161；现场 live 61 / 需重启 0） | ✓ 已实测（2026-09-22 复核） |
| A2 | 五环真的跑过（不是空机制） | `self-test.json`：16 条假设 = confirmed 9 / refuted 6 / active 1（mtime 2026-09-14 10:13） | ✓ 已实测 |
| A3 | 布线物证存在 | `AGENTS.md` 含 `<!-- dsh-agent-self-test:start -->` … `end` 块（内容为「机制异常先取证」规则） | ✓ 已实测 |
| A4 | 五族探针的判定与边界 | `node --test "tests/*.test.mjs"`（7 套件：burst / claim-evidence / cluster / failure-rate / polarity / probe / wiring） | ✓ 已实测（2026-09-22，101/101） |
| A5 | 工具可答：`selftest_findings` 返回当前 finding 数 | 调 `selftest_findings` → 与 `self-test.json` 中 `status='finding'` 条数一致 | 待验收 |
| A6 | 采证只作用于主会话 | 让子代理触发工具 → `self-test.json` 证据数**不增** | 待验收 |
| A7 | confirm 布线可回滚 | 布线后 `ls $DSH_HOME/agent-self-test/backups/` 出现 `.bak-<ts>`，内容为布线前的 AGENTS.md | 待验收 |
| A8 | finding 通知真的落到会话 | 造一条阈值 1 的假设 + 触发一次匹配工具调用 → 会话出现 `[self-test] …` 消息 | 待验收 |
| A9 | 双证据方向区分 | `self-test.json` 中 canonical `detail.verdict` 同时出现 `violated` 与 `survived`（tool-failure-rate 侧 survived、probe-before-action 侧 violated） | ✓ 已实测 |
| A10 | **假设极性生效**：`selftest_list` 对每条假设给出方向判定，并标出「状态=confirmed 但方向**非纯支持**（且非「倾向支持」）」的存量误判（判据 2026-09-20 细化，见 §4.2） | 修复前 `polaritySuspects=7`（6 反对 + 1 混杂，逐条 id 见 §9 记录）；7 条处置后归零 | ✓ 已实测 |
| A11 | **裁决护栏 + 返回值无损**：方向相悖时 `selftest_review` 返回 `polarityWarning`（不阻断）；可选键**不存在**而非 `undefined` | 线上两次 refine 返回 `裁决完成：…（证据 0 条；方向 mixed）`，无 `invalid output: value is not lossless JSON` | ✓ 已实测 |
| A12 | 五族探针载荷契约统一（`verdict` 字段 + 词表 `violated`/`survived`） | `node --test "tests/*.test.mjs"` → `# tests 68 / # pass 68 / # fail 0`（含 `tests/polarity.test.mjs` 的「载荷契约」两例） | ✓ 已实测 |
| A13 | **对照组补齐**：`plan-before-action` 能采到「有规划且零失败」的**正向**证据（旧实现结构上只产违规证据） | **单测**：`node --test "tests/*.test.mjs"` → `# tests 74 / # pass 74 / # fail 0`（+6 例双路径夹具）。**线上**：受控实验（人为造 >60s 空隙 ⇒ 新突发以 `todo_write` 诞生 ⇒ 同批补满 5 次零失败调用）后 `h-mu4judte-1` **自动采到 survived**（证据 1/3、方向「支持」） | ✓ 已实测 |
| A14 | **布线 upsert 幂等 + 预算拒写**（含两次「丢规则」事故的复刻） | `node --test "tests/*.test.mjs"` → `# tests 101 / # pass 101 / # fail 0`（7 套件）；其中 `tests/wiring.test.mjs` 含事故复刻用例「连续两次布线后，块内必须同时含两条规则（旧实现会丢第一条）」与「同规则幂等 ⇒ 一字不写」「超预算 ⇒ `allowed=false` 且回报字节与余量」 | ✓ 已实测（2026-09-22） |
| A15 | **收敛提示只在建前送达、且不阻断** | 纯函数：`src/cluster.ts detectCluster`（阈值 `CLUSTER_THRESHOLD=3`，只算同族**终态**）；单测：`tests/cluster.test.mjs`（含尸体测试「plan-before-action 血脉 7 条全终态 ⇒ 必须提示，且『第 8 条』的数算对」）——在上述 101/101 内。线上读数（同族终态 ≥3 时 `selftest_add` 返回非空 `clusterNote`）尚未取 | 待线上验收 |
| A16 | **倾向度分档不改变旧语义**（I9） | 单测：`tests/polarity.test.mjs` 覆盖 `lean` 分档与「`lean` 缺省 ⇒ 旧行为不变」的向后兼容（在 101/101 内）。线上读数（`selftest_list` 行内显示 `·倾向支持 7:1`）尚未取 | 待线上验收 |

## 8 · 与实现的关系

- **主实现**：`src/index.ts`。**纯逻辑层**（可离线单测，`dsh-plugin-testability` 模式）：`burst.ts` / `probe.ts` / `failure-rate.ts` / `claim-evidence.ts` / `polarity.ts` / `wiring.ts` / `cluster.ts`（7 个模块，各有同名 `tests/*.test.mjs`）。
- **同语义副本（I1）**：无。**相邻但不同主**：`dsh-agent-emotion` 也统计工具调用成功率，但语义不同（统计「发生了什么」 vs 检验「关于自己的假设是否成立」），两者**不互为副本**。
- **未实现 / 未验证部分（显式标注）**：
  1. `PROBE_TOOLS` / `MUTATING_TOOLS` 是**静态清单**（含 WQ / 安全 / ComfyUI 等工具名）——工具面变化后清单会腐化；无自检机制（未验证）。
  2. `evidence` 数组**无上限**（`addEvidence` 只 push）——长期运行的假设会无限增长（当前 16 条假设文件 41.5KB，尚可）。
  3. 通知失败不重试（§5 失败面）。
  4. `read-repeat` 的 `readTimes` 只留最近 20 次且**仅内存**：重启即失忆。
  5. ~~**`plan-before-action` 没有对照组**~~ **已闭环（2026-09-17，任务 t-bede2fab）**：`burst.ts` 现有双路径结算（有规划 + 零失败 ⇒ `verdict:'survived'`；无规划 + ≥1 失败 ⇒ `verdict:'violated'`；其余两种形态不记），并修正了旧实现把 `hadPlan` 写死为 `false` 的自相矛盾（`hadPlan` 与 `verdict` 必须自洽）。**残余限制**：探针产出的是**单次事件**而非**比率** ⇒ 「有规划突发的失败率更低」这类**比较型**主张仍需聚合层（见 U7）。
  6. **本文档描述的实现与 git head 不一致**（2026-09-22 复核时新增）：0.6.0（cluster + lean）**只存在于工作区**、未提交，但**已构建并 live**（判据见 §9 追补条）。若该工作区改动被丢弃/回退，本文档 §2 的「收敛提示 / 倾向度」、§3 I9/I10、§4.2 倾向度段、§7 A15/A16 需同步回退——判据：`git status --porcelain` 非空即处此状态（见 U8）。
  7. **收敛阈值 3 缺实验支撑**（未验证）：`CLUSTER_THRESHOLD=3` 是经验值，且提示**只在 `selftest_add` 入口生效**——已存在的重开簇不会被提示（没有周期性巡检面）。
- **生效判据**（改了代码后怎么证明真的生效）：
  1. **产物 vs 进程**：`lib/index.js` mtime 早于 web 进程启动时间（当前 `2026-09-20 20:24:18` < `2026-09-22 12:29:33` ✓ live；`plugin_boot_status` 可一条命令复核）。**改了探针代码必须重建 + 重启**才生效。
  2. **落盘物证**：`$DSH_HOME/agent-self-test/self-test.json` 的 mtime 前进（每次采证/裁决都写）；`backups/` 出现新 `.bak-*`（布线）。
  3. **工具可答**：`selftest_list` / `selftest_findings` 返回与状态文件一致的内容——**工具面即自证**（`selftest_list` 的渲染会显示证据数/阈值/倾向度）。
- **回退**：
  - 组合面：`plugin_stop dsh-agent-self-test`（patch `disabled: true` + 预检 + 哨兵重启）——采证停止，**已有假设与 AGENTS.md 布线块保留**。
  - 布线面（**最重要**）：`confirm` 写入的规则块污染行为时——① 手工删除 `AGENTS.md` 的 marker 块，或 ② 从 `$DSH_HOME/agent-self-test/backups/AGENTS.md.bak-<ts>` 恢复，或 ③ `checkpoint_restore`（存档含 AGENTS.md）。
  - 代码面：`git revert <commit>`（已提交 head `468f867`）+ `pnpm build`。
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

**2026-09-17 追加：突发边界与 `hadPlan` 冻结语义（受控实验 · 任务 `t-bede2fab`）**

- **现象**：v0.5.0 上线后 `plan-before-action` 连续多批调用「零证据」——**不是 survived 没火，是该探针根本没触发**（同期同族 `probe-before-action` 正常产出 2 条 survived，证明传感器与主会话过滤都健康）。
- **受控实验**（决定性）：① 先跑一次 120s 调用，人为制造 > `burstGapMs`(60s) 的空隙 ⇒ 旧突发确定性结束；② 下一批**首个调用即 `todo_write`**（新突发诞生时 `lastTodoTs = now` ⇒ `hadPlan=true`）；③ 同批紧凑补满 5 次调用且零失败 ⇒ **survived 自动产出**（`h-mu4judte-1` 证据 1/3、方向「支持」）。
- **机制结论（文档必须写清，否则下一个维护者会重复我的三次误判）**：
  1. **突发边界由「相邻调用间隔 > `burstGapMs`」决定，不由「回合/批次」决定**——连续批次（间隔 <60s）会**合并**成同一突发。
  2. **`hadPlan` 在突发诞生瞬间冻结**：同一突发内后补 `todo_write` **无效** ⇒ 「规划」必须真的发生在突发**之前**（与 §5.8 序位判据语义一致：台账先落，再动手）。
  3. 因此在「长会话 + 连续批次」模式下，该探针可长时间停在 active 而不产证据——**这是边界，不是故障**；要拿到正向证据，需要一次「真实空隙 + 规划开场」的突发。
- **方法论教训**：连续三次「我以为的原因」（突发被切开 → 传感器死 → 接线坏）**全被推翻**，第四次靠**人为造条件的受控实验**才定性。**能造条件的，就不要靠推断。**

**2026-09-22 复核回写（D3「实现比文档新」⇒ 判定：真过时）**

- **触发链（取证）**：本文件最后提交 `41c0273`（2026-09-17 04:29，任务 `t-bede2fab`）；**4 小时后** `468f867`（2026-09-17 14:00，任务 `t-d7b9739f`）改写了布线的**核心语义**——`src/index.ts` +98/−20、新增 `src/wiring.ts` + `tests/wiring.test.mjs`、`Config` 加 `agentsMaxBytes`。本文件当时**未同步**。
- **被修正的语义**（这是本次回写的主因）：
  1. **§3 I6 原文**：「marker 块已存在则**整体替换**，不追加第二块」——这正是**两次丢规则事故的行为**（`full.replace(/start[\s\S]*end/, block)` 隐含假设「块里只有一条规则」，而块是累积的 ⇒ 第二次 confirm 抹掉第一次的规则；2026-09-16 / 09-17 各丢一条，只有字节数反降 65,151→64,795 才暴露）。**现行为**：upsert（同规则幂等跳过 / 新规则追加块尾 / 既有条目一字不动）+ 预算守卫（超 `agentsMaxBytes`=65000 ⇒ **拒写**并回报，绝不静默截断尾部）。
  2. **§4.1 缺 `agentsMaxBytes`**：配置项表此前完全没有（patch 里无 config，故「全默认」这句话掩盖了「有一项会拦写入」的事实）——已补配置表。
  3. **§5 失败面「布线失败 → `{wired:false, error}`」**：语义已扩为**四态** `added`/`exists`/`rejected`/`error`，且四态必须在 render 里**当场可见**（可见面纪律）。
  4. **§4.3 / §8 缺 `src/wiring.ts`**：布线纯函数层（`normalizeRule`/`upsertRuleBlock`/`checkBudget`/marker 单一真源）此前在实现清单里不存在；**行号锚点整体漂移**（本文件所有 `index.ts:*` 已按工作区重新核对）。
- **教训（两个方向都要读 diff，不能只读时间戳）**：
  - 「**提交时间在后 ≠ 内容已吸收**」：本文件 09-17 04:29 的提交晚于 09-17 之前的实现，却漏掉了 4 小时后的改写。
  - 「**mtime 在后 ≠ 内容过时**」：同批复核的另两条（`agent-browser` / `telegram-outbound`）mtime 更新，但改动只是 DSH 0.1.6 平台适配，属于**假报**（详见各自文档 §9 的复核记录）。
  - ⇒ **D3 的两个方向都只能靠读 diff 判**；`touch` 文档能让告警消失，但那次复核不存在。

**2026-09-22 追补（工作区 0.6.0；已构建并 live，尚未提交）**

- **回写内容**：`src/cluster.ts`（同族重开簇检测 —— `selftest_add` 建前提示三选一，**不阻断**）+ `src/polarity.ts` 倾向度分档（`Lean` / `ratio` / `LEAN_THRESHOLD=0.8`；`contradictsDirection` 接受可选 `lean`，缺省行为不变）+ `selftest_list.polaritySuspects` 判据细化（方向混杂但**倾向支持**不再计入）+ `selftest_add` 返回并渲染 `clusterNote`；`package.json` 0.5.1 → **0.6.0**。
- **判据（为什么敢写进文档）**：`lib/*.js` mtime `2026-09-20 20:24:18` **早于** web 进程启动 `2026-09-22 12:29:33`（`plugin_boot_status`：进程启动 1790051373161，现场 live 61 / 需重启 0）；`grep -c clusterNote lib/index.js` = 4、`lean-support` = 2 ⇒ 运行中的构建**已含**这些语义。
- **边界（如实标注）**：这些改动**尚未提交**（`git status --porcelain` 非空；已提交 head 仍是 `468f867` = v0.5.1）。本文档描述的是**工作区+live 构建**的实现，故 §8 未验证清单第 6 条与 U8 明写此风险。

## 10 · 未决问题

- **U1 探针工具清单的自维护**：`PROBE_TOOLS`/`MUTATING_TOOLS` 靠手维护（新增工具后不会自动归类）。倾向：加一条 `claim-vs-evidence` 式元假设——「未分类的工具占比 > X%」即提示清单腐化。
- **U2 状态文件损坏静默重置**：与「坏数据放行 + 落 issue」纪律不符。倾向：重置前把坏文件另存为 `self-test.json.corrupt-<ts>` 并记 warn。
- **U3 evidence 数组无上限**：倾向保留最近 N 条 + 计数（裁决只需条数与方向，不需全部明细）。
- **U4 finding 通知失败无重试**：是否改为「落盘待通知队列 + 启动补发」（与 telegram outbox 同款）？
- **U5 `workspaceDir` 缺省 `process.cwd()`**：web 进程 cwd 是工作区，但 watch/sentinel 类场景下 cwd 可能不同——是否需要像其他插件一样显式配置？
- ~~**U6 `plan-before-action` 缺对照组**~~ **已闭环（2026-09-17，任务 t-bede2fab）**：`src/burst.ts` 已补 `survived` 路径（有规划且零失败），并修正 `hadPlan` 写死为 `false` 的自相矛盾；重开检验见 `h-mu4judte-1`（验收 A13）。
- **U7 比较型主张仍需聚合层**（2026-09-17 新增）：五族探针产出的是**单次事件**（`violated`/`survived`），而「有规划突发的失败率**低于**无规划突发」这类**比率比较**主张需要跨突发的分子/分母（含未达 `minSteps` 的短突发）——当前无聚合面 ⇒ 该类主张仍**不可判**（**禁止用事件计数冒充比率**：那样会把「对照组多」读成「对照组更好」）。倾向：加按「有无规划」分桶的计数器（`planned:{bursts,failures}` / `unplanned:{...}`）+ 存活期随状态落盘，并用一条元假设检验其稳定性。
- **U8 文档描述的版本与 git head 不一致**（2026-09-22 复核新增）：本文档按**工作区 0.6.0**（cluster + lean，已构建并 live）回写，而 git head 仍是 `468f867`/v0.5.1 —— 任何人 `git checkout`/`reset --hard` 都会让文档描述一场仓库里不存在的实现。倾向：尽快把 0.6.0 提交并升版，让「文档所描述 = 仓库所存」；同批提交里顺带把 §4.3 的行号锚点再核一次。
- **U9 收敛提示只有「建前」一个触发点**（2026-09-22 新增）：`detectCluster` 只在 `selftest_add` 时说话 ⇒ **已存在的重开簇永远不被提示**（`plan-before-action` 一族已重开 7 次，靠人工发现）。倾向：把同族终态计数顺带放进 `selftest_list` / `selftest_findings` 的输出（成本近零，取样点从「建前」扩到「每次看假设库」）。阈值 3 亦缺实验支撑，宜由数据定（见 §8 未验证清单第 7 条）。
