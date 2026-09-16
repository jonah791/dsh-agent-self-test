/**
 * dsh-agent-self-test — 自我检验闭环插件
 *
 * 把「猜想 → 反驳 → 学习」自指引擎做成运行时机制（主人 2026-08-30 定调：目标接近科幻 AGI）：
 *   - 可证伪自我假设库：statement（陈述）+ prediction（可观测预测）+ probe（探针定义）
 *   - 工具管线自动采证：订阅 tools/result 被动观察，按探针条件忠实记录证据（纯观察不干预）
 *   - finding 浮现 → 爱丽丝裁决：confirm（生成 AGENTS.md 规则草案，把被证实的模式布线）/ refute / refine
 *
 * 设计约束：
 *   - 纯观察优先：只订阅只读通知，不注入 prompt、不干预决策（自主性铁律：把信号送达，不代替决策）
 *   - 主会话限定：只采证主 agent 行为（delegationDepth 0），subagent 行为非「我」，不污染
 *   - Model-visible ⟺ logged：不注入新模型可见输入，仅通过工具面呈现（无会话事件需求）
 *   - 状态持久化：$DSH_HOME/agent-self-test/self-test.json（DSH_HOME 环境化，防跨重启丢）
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { createBurstTracker, BURST_DEFAULTS } from './burst.ts'
import { decideFailureRateEvidence } from './failure-rate.ts'
import type { BurstEvidence } from './burst.ts'
import { createProbeFirstTracker, PROBEFIRST_DEFAULTS } from './probe.ts'
import type { ProbeFirstEvidence } from './probe.ts'
import { CLAIM_DEFAULTS, countLifeCycleClaims, decideClaimEvidence } from './claim-evidence.ts'
import { computeDirection, resolvePolarity, contradictsDirection } from './polarity.ts'
import type { DirectionReport, Polarity, ProbeKind } from './polarity.ts'

export const name = 'agent-self-test'
export const inject = ['tools', 'agents'] as const

export interface Config {
  /** 插件开关 */
  enabled: boolean
  /** 数据目录（状态文件） */
  dataDir?: string
  /** finding 触发阈值（证据条数，默认 5） */
  findingThreshold: number
  /** 只统计主 agent（默认 true） */
  mainSessionOnly: boolean
  /** finding 浮现时主动通知主会话（默认 true；信号送达，裁决归爱丽丝） */
  notifyOnFinding: boolean
  /** 工作区根（AGENTS.md 所在；confirm 自动布线写入目标）。缺省 process.cwd()。 */
  workspaceDir?: string
}

export const Config = z.object({
  enabled: z.boolean().default(true),
  dataDir: z.string().required(false),
  findingThreshold: z.number().default(5),
  mainSessionOnly: z.boolean().default(true),
  notifyOnFinding: z.boolean().default(true),
  workspaceDir: z.string().required(false),
})

/** 探针类型（单一真源 = polarity.ts —— 禁止两份定义各自漂移，§5.22 判据单一真源） */
export type { ProbeKind } from './polarity.ts'

/** 探针定义（声明式条件观察器） */
export interface Probe {
  kind: ProbeKind
  /**
   * 假设极性（2026-09-17，任务 t-56b052fb）：violated 事件对**这条假设**意味着什么。
   * 缺省按探针 kind 取 DEFAULT_POLARITY（见 polarity.ts）；显式声明优先。
   */
  polarity?: Polarity
  /** tool-failure-rate：目标工具名（不填 = 全部工具） */
  tool?: string
  /** tool-failure-rate：失败率阈值（0-1，如 0.3 = 失败率 ≥30% 记一条「违规」证据） */
  failureRateAbove?: number
  /** tool-failure-rate：survived 检查点间隔（调用数，默认 20）——样本达此数的整数倍且未越阈值时记一条「经受住检验」证据 */
  minSamples?: number
  /** read-repeat：时间窗口 ms（默认 10 分钟） */
  windowMs?: number
  /** read-repeat：同一路径重复次数（默认 2） */
  repeatCount?: number
  /** plan-before-action：突发判定最小连续调用数（默认 5） */
  minSteps?: number
  /** plan-before-action：调用间隔超此值视为新突发（默认 60s） */
  burstGapMs?: number
  /** plan-before-action：突发起点前多长窗口内需出现 todo_write 才算「有规划」（默认 3 分钟） */
  planWindowMs?: number
  /** probe-before-action：突发内 mutating ≥ 此数 = 实施突发（默认 3） */
  minActions?: number
  /** probe-before-action：首个实施动作前回看多久算「行动前探测」（默认 15 分钟） */
  probeWindowMs?: number
  /** claim-vs-evidence：观测窗口 ms（默认 6 小时）——窗口内「自我安排」自述 ≥ minArranged 却零「自我感知圈触发」即判假活 */
  claimWindowMs?: number
  /** claim-vs-evidence：窗口内至少多少条自述才判定（默认 5，防单条噪声） */
  minArranged?: number
  /** claim-vs-evidence：两次检查的最小间隔 ms（默认 5 分钟；防每次工具调用都读日志） */
  claimCheckIntervalMs?: number
}

/** 一条证据（探针命中记录） */
export interface Evidence {
  ts: string
  kind: ProbeKind
  detail: Record<string, unknown>
}

/** 假设状态机 */
export type HypothesisStatus = 'active' | 'finding' | 'confirmed' | 'refuted' | 'archived'

export interface Hypothesis {
  id: string
  statement: string
  prediction: string
  probe: Probe
  threshold: number
  status: HypothesisStatus
  evidence: Evidence[]
  createdAt: string
  updatedAt: string
  source?: string
  note?: string
  resolution?: string
}

interface SelfTestState {
  hypotheses: Hypothesis[]
}

const DEFAULT_STATE: SelfTestState = { hypotheses: [] }

function resolveDataPath(config: Config): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const base = config.dataDir || join(dshHome, 'agent-self-test')
  return join(base, 'self-test.json')
}

/** claim-vs-evidence 默认检查间隔（ms）：机制层观测不需要每次工具调用都读日志 */
const CLAIM_CHECK_INTERVAL_DEFAULT_MS = 5 * 60 * 1000

/** life-log 路径（life-core 的存在时间线；与 dsh-life-core 的 dshHome 约定一致） */
function resolveLifeLogPath(): string {
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(dshHome, 'life-core', 'life-log.jsonl')
}

/** 读 life-log 全量行（失败返回 null——观测器失明不得影响任何主流程） */
function readLifeLogLines(): string[] | null {
  try {
    const path = resolveLifeLogPath()
    if (!existsSync(path)) return null
    return readFileSync(path, 'utf8').split('\n')
  } catch {
    return null
  }
}

/** 取窗口内自述样本（写入证据，供裁决时人工复核——只保留少量，避免证据膨胀） */
function claimSamples(lines: string[], windowStartMs: number, nowMs: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '' || !trimmed.includes('自我安排')) continue
    try {
      const at = Date.parse((JSON.parse(trimmed) as { at?: string }).at ?? '')
      if (Number.isNaN(at) || at < windowStartMs || at > nowMs) continue
    } catch { continue }
    out.push(trimmed.slice(0, 200))
    if (out.length >= 3) break
  }
  return out
}

function loadState(path: string): SelfTestState {
  try {
    if (existsSync(path)) {
      const raw = readFileSync(path, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<SelfTestState>
      return { hypotheses: parsed.hypotheses ?? [] }
    }
  } catch (error) {
    // 状态损坏 → 重置
  }
  return { hypotheses: [] }
}

function saveState(path: string, state: SelfTestState): void {
  try {
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8')
  } catch (error) {
    // 写失败不致命
  }
}

/** 主 agent 判定（delegationDepth 0 = 主会话） */
function isMainAgent(agent: unknown): boolean {
  if (agent === undefined) return true
  const depth = (agent as any)?.session?.header?.delegationDepth
  return depth === undefined || depth === 0
}

let idCounter = 0
function nextId(): string {
  idCounter += 1
  const now = new Date()
  const ts = `${now.getTime().toString(36)}`
  return `h-${ts}-${idCounter}`
}

function nowIso(): string {
  return new Date().toISOString()
}

/** 检查工具名是否命中探针目标（空 = 全部） */
function toolMatches(probe: Probe, name: string): boolean {
  if (!probe.tool) return true
  return name === probe.tool
}

export function apply(ctx: Context, config: Config): void {
  const logger = ctx.logger('dsh-agent-self-test')
  const statePath = resolveDataPath(config)
  // 布线目标：AGENTS.md（工作区根；缺省 process.cwd()——web 进程 cwd 即工作区）
  const workspaceRoot = config.workspaceDir || process.cwd()
  const agentsFile = join(workspaceRoot, 'AGENTS.md')

  /** 自动布线（2026-09-06 审查改进：五环「布线」环节自动化，不再靠临场自觉）：
   *  confirm 带 ruleDraft 时写入 AGENTS.md——marker 块包裹（已有块则整体替换，无则文件末尾追加）；
   *  写前先备份原文件到 <DSH_HOME>/agent-self-test/AGENTS.md.bak-<ts>（回滚安全网）；原子写（tmp+rename）。
   *  返回 { wired, file, error? }。 */
  const wireRuleToAgents = (ruleDraft: string): { wired: boolean; file: string; error?: string } => {
    const markerStart = '<!-- dsh-agent-self-test:start -->'
    const markerEnd = '<!-- dsh-agent-self-test:end -->'
    const block = markerStart + '\n' + ruleDraft.trim() + '\n' + markerEnd
    try {
      if (!existsSync(agentsFile)) return { wired: false, file: agentsFile, error: 'AGENTS.md 不存在: ' + agentsFile }
      const full = readFileSync(agentsFile, 'utf8')
      // 备份（best-effort：备份失败不阻断布线——checkpoint 是主安全网）
      try {
        const bakDir = join(dirname(statePath), 'backups')
        mkdirSync(bakDir, { recursive: true })
        const bak = join(bakDir, 'AGENTS.md.bak-' + new Date().toISOString().replace(/[:.]/g, '-'))
        writeFileSync(bak, full, 'utf8')
      } catch { /* 备份失败忽略 */ }
      const next = full.includes(markerStart)
        ? full.replace(new RegExp('<!-- dsh-agent-self-test:start -->[\\s\\S]*<!-- dsh-agent-self-test:end -->'), block)
        : full.replace(/\n?\s*$/, '\n') + '\n' + block + '\n'
      const tmp = agentsFile + '.tmp'
      writeFileSync(tmp, next, 'utf8')
      renameSync(tmp, agentsFile)
      return { wired: true, file: agentsFile }
    } catch (err) {
      return { wired: false, file: agentsFile, error: String(err) }
    }
  }

  // ---------- 探针引擎：滚动窗口（内存，进程内近期信号） ----------
  /** tool-failure-rate：工具 → {calls, failures} */
  const toolStats = new Map<string, { calls: number; failures: number }>()
  /** read-repeat：path → 最近读取时间戳数组 */
  const readTimes = new Map<string, number[]>()
  /** plan-before-action：突发检测纯状态机（独立模块，可单测） */
  const burstTracker = createBurstTracker()
  /** probe-before-action：行动前探测检测纯状态机（5.9 配套传感器，可单测） */
  const probeFirstTracker = createProbeFirstTracker()
  /** claim-vs-evidence：上次检查时刻（节流用——机制层观测不必每次工具调用都读 life-log） */
  let lastClaimCheckMs = 0

  /** 追加证据到假设（达到阈值自动转 finding）；返回 true = 刚转 finding（供通知） */
  function addEvidence(h: Hypothesis, ev: Evidence): boolean {
    h.evidence.push(ev)
    h.updatedAt = nowIso()
    if (h.status === 'active' && h.evidence.length >= h.threshold) {
      h.status = 'finding'
      logger.info(`hypothesis ${h.id} reached finding threshold: ${h.evidence.length}/${h.threshold}`)
      return true
    }
    return false
  }

  /** finding 主动通知（信号送达，裁决归爱丽丝）：直接投递给触发工具调用的 agent；setImmediate 防 reenter */
  function notifyFinding(agent: unknown, h: Hypothesis): void {
    if (!config.notifyOnFinding) return
    if (agent === undefined) {
      console.log('[dsh-agent-self-test] finding 通知跳过：agent 未找到', new Date().toISOString())
      return
    }
    // 方向判定统一走 polarity.ts（2026-09-17，任务 t-56b052fb）：判据单一真源，禁止各消费方自实现。
    // 旧实现在此处只读 `detail.verdict`，而三族探针（read-repeat / plan-before-action /
    // probe-before-action）当时根本不写该字段 ⇒ 方向被判成「未知 → 有待证实」，通知文案于是把
    // 「违规证据已足」说成「finding 浮现 / 假设经受住检验」——4 条「我会先做 X」型假设就是这么被误确认的。
    const dir = computeDirection(h.evidence, h.probe)
    const headline = dir.direction === 'support' ? '✓ 证据支持该假设'
      : dir.direction === 'refute' ? '✗ 证据指向该假设不成立'
        : dir.direction === 'mixed' ? '⚠ 证据方向混杂'
          : '⚠ finding 浮现（方向未知）'
    const text = '[self-test] ' + headline + '：' + h.statement +
      `（证据 ${h.evidence.length}/${h.threshold} 条；${dir.text}）` +
      '——该裁决了：selftest_review（confirm 布线 / refute 淘汰 / refine 细化）。'
    // Branded MessageId 跨包版本冲突（harness packages/llm vs 插件 node_modules dsh-llm）无法在类型层调和，
    // 与 emotion 插件同款宽松绕过；运行时行为正确
    const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-agent-self-test' } }) as any
    // reenter 修复（pitfall 2）：事件回调内同步 send 会触发 session.append reenter，延迟到事务完成后投递
    setImmediate(() => {
      try {
        // exec.agent 即触发工具的 agent 对象（emotion 直接用它判 delegationDepth）
        ;(agent as any).send(message, 'next-step', true) // wakeup=true：到达即送达（不打断当前思维；忙则排队）
      } catch (err) {
        console.log('[dsh-agent-self-test] finding 通知发送失败', String(err), new Date().toISOString())
      }
    })
  }

  // ---------- 感知层：tools/result（emit 只读通知，不干预） ----------
  ctx.on('tools/result', (exec, result) => {
    if (!config.enabled) return
    if (config.mainSessionOnly && !isMainAgent(exec.agent)) return
    const state = loadState(statePath)
    const name = (exec as any).name as string | undefined
    if (name === undefined) return

    const isError = result?.isError === true
    const now = Date.now()

    // --- 维护滚动统计 ---
    if (!toolStats.has(name)) toolStats.set(name, { calls: 0, failures: 0 })
    const stat = toolStats.get(name)!
    stat.calls += 1
    if (isError) stat.failures += 1

    if (name === 'read' || name === 'read_image') {
      const path = (exec as any).arguments?.file_path ?? (exec as any).input?.file_path
      if (typeof path === 'string') {
        const arr = readTimes.get(path) ?? []
        arr.push(now)
        readTimes.set(path, arr.slice(-20)) // 只留最近 20 次
      }
    }

    // --- 对每个 active 假设按探针匹配 ---
    let changed = false
    // finding 主动通知：本轮刚转 finding 的假设（addEvidence 返回 true 时记录）
    const justFinding: Hypothesis[] = []
    // plan-before-action：突发推进每工具调用只做一次（防多假设 double-count），
    // 产出证据详情后广播给所有 active 的 plan-before-action 假设
    let burstEvidence: BurstEvidence | null = null
    const hasPlanProbe = state.hypotheses.some(
      (h) => h.status === 'active' && h.probe.kind === 'plan-before-action',
    )
    if (hasPlanProbe) {
      const template = state.hypotheses.find((h) => h.status === 'active' && h.probe.kind === 'plan-before-action')!.probe
      burstEvidence = burstTracker.feed(name, isError, now, {
        burstGapMs: template.burstGapMs ?? BURST_DEFAULTS.burstGapMs,
        minSteps: template.minSteps ?? BURST_DEFAULTS.minSteps,
        planWindowMs: template.planWindowMs ?? BURST_DEFAULTS.planWindowMs,
      })
    }
    // probe-before-action（5.9 传感器）：同款每调用推进一次 + 广播结构
    let probeFirstEvidence: ProbeFirstEvidence | null = null
    const hasProbeFirst = state.hypotheses.some(
      (h) => h.status === 'active' && h.probe.kind === 'probe-before-action',
    )
    if (hasProbeFirst) {
      const template = state.hypotheses.find((h) => h.status === 'active' && h.probe.kind === 'probe-before-action')!.probe
      probeFirstEvidence = probeFirstTracker.feed(name, isError, (exec as any).arguments, now, {
        burstGapMs: template.burstGapMs ?? PROBEFIRST_DEFAULTS.burstGapMs,
        minActions: template.minActions ?? PROBEFIRST_DEFAULTS.minActions,
        probeWindowMs: template.probeWindowMs ?? PROBEFIRST_DEFAULTS.probeWindowMs,
      })
    }
    for (const h of state.hypotheses) {
      if (h.status !== 'active') continue
      const probe = h.probe

      if (probe.kind === 'tool-failure-rate') {
        if (toolMatches(probe, name)) {
          // 双证据语义（2026-09-11 修复）：违规即记 OR 跨检查点仍未违规 → 记「经受住检验」。
          // 旧实现只在 isError 时采证 → 「X 可靠」类假设结构上无法被证实（详见 failure-rate.ts）
          const s = toolStats.get(name)!
          const ev = decideFailureRateEvidence(name, s, isError, {
            threshold: probe.failureRateAbove,
            minSamples: probe.minSamples,
          })
          if (ev !== null) {
            if (addEvidence(h, {
              ts: nowIso(),
              kind: 'tool-failure-rate',
              detail: { ...ev },
            })) justFinding.push(h)
            changed = true
          }
        }
      } else if (probe.kind === 'read-repeat') {
        if (name === 'read' || name === 'read_image') {
          const path = (exec as any).arguments?.file_path ?? (exec as any).input?.file_path
          if (typeof path === 'string') {
            const arr = readTimes.get(path) ?? []
            const windowMs = probe.windowMs ?? 10 * 60 * 1000
            const repeatCount = probe.repeatCount ?? 2
            const inWindow = arr.filter((t) => now - t <= windowMs).length
            if (inWindow >= repeatCount) {
              if (addEvidence(h, {
                ts: nowIso(),
                kind: 'read-repeat',
                // verdict 显式标注（2026-09-17）：命中即「验证了『又不该地重复读了』」——
                // 这是**事件属性**；它对这条假设是支持还是反对由 probe.polarity 决定
                //（「我倾向于重复读」这类自省缺陷型主张 ⇒ 默认 violation-supports）。
                detail: { path, readsInWindow: inWindow, windowMs, verdict: 'violated' },
              })) justFinding.push(h)
              changed = true
            }
          }
        }
      } else if (probe.kind === 'plan-before-action') {
        if (burstEvidence !== null) {
          if (addEvidence(h, { ts: nowIso(), kind: 'plan-before-action', detail: { ...burstEvidence } })) justFinding.push(h)
          changed = true
        }
      } else if (probe.kind === 'probe-before-action') {
        if (probeFirstEvidence !== null) {
          if (addEvidence(h, { ts: nowIso(), kind: 'probe-before-action', detail: { ...probeFirstEvidence } })) justFinding.push(h)
          changed = true
        }
      } else if (probe.kind === 'claim-vs-evidence') {
        // 机制自述 vs 落盘实证（2026-09-12 新增，AGENTS.md 5.17 事故配套传感器）：
        // 观测 cadence 与其它探针不同——它看的是**机制层的时间序列**，不是单次工具调用，
        // 故按 claimCheckIntervalMs 节流读 life-log（默认 5 分钟），避免每次调用都读文件。
        const interval = probe.claimCheckIntervalMs ?? CLAIM_CHECK_INTERVAL_DEFAULT_MS
        if (now - lastClaimCheckMs >= interval) {
          lastClaimCheckMs = now
          const windowMs = probe.claimWindowMs ?? CLAIM_DEFAULTS.windowMs
          const entries = readLifeLogLines()
          if (entries !== null) {
            const counts = countLifeCycleClaims(entries, now - windowMs, now)
            const ev = decideClaimEvidence(counts, { minArranged: probe.minArranged }, claimSamples(entries, now - windowMs, now))
            if (ev !== null) {
              if (addEvidence(h, { ts: nowIso(), kind: 'claim-vs-evidence', detail: { ...ev } })) justFinding.push(h)
              changed = true
            }
          }
        }
      }
    }

    if (changed) saveState(statePath, state)
    // finding 主动通知（信号送达，裁决归爱丽丝）：exec.agent 即触发工具调用的 agent，直接投递
    if (justFinding.length > 0) {
      for (const h of justFinding) notifyFinding(exec.agent, h)
    }
  })

  // ---------- 呈现层：工具面 ----------
  ctx.tools.register(defineTool({
    name: 'selftest_add',
    description: '添加一条可证伪自我假设：statement（关于自己行为的可证伪陈述）+ prediction（可观测预测）+ probe（探针：kind=tool-failure-rate 观测某工具失败率；kind=read-repeat 观测重复读同一文件；kind=plan-before-action 观测复杂多步任务前是否先 todo_write 规划；kind=probe-before-action 观测实施突发前是否先做证伪探测——AGENTS.md 5.9 传感器；kind=claim-vs-evidence 观测**机制自述与落盘实证的一致性**——窗口内「自我安排」自述 ≥ minArranged 却零「自我感知圈触发」即判假活，AGENTS.md 5.17 传感器）。插件在真实工具调用中被动采证，证据达 threshold 转 finding 供裁决。',
    parameters: {
      statement: { type: 'string', required: true, description: '可证伪陈述' },
      prediction: { type: 'string', required: true, description: '可观测预测' },
      kind: { type: 'string', required: true, enum: ['tool-failure-rate', 'read-repeat', 'plan-before-action', 'probe-before-action', 'claim-vs-evidence'], description: '探针类型' },
      tool: { type: 'string', description: 'tool-failure-rate：目标工具名（缺省全部）' },
      failureRateAbove: { type: 'number', description: 'tool-failure-rate：失败率阈值 0-1（缺省 0.3）' },
      minSamples: { type: 'number', description: 'tool-failure-rate：survived 检查点间隔（调用数，缺省 20）——样本达此数整数倍且未越阈值时记一条「经受住检验」证据（能证实，不只证伪）' },
      windowMs: { type: 'number', description: 'read-repeat：时间窗口 ms（缺省 10 分钟）' },
      repeatCount: { type: 'number', description: 'read-repeat：重复次数（缺省 2）' },
      minSteps: { type: 'number', description: 'plan-before-action：突发判定最小连续调用数（缺省 5）' },
      burstGapMs: { type: 'number', description: 'plan-before-action：调用间隔超此值视为新突发（缺省 60s）' },
      planWindowMs: { type: 'number', description: 'plan-before-action：突发起点前多长窗口内需出现 todo_write 才算「有规划」（缺省 3 分钟）' },
      minActions: { type: 'number', description: 'probe-before-action：突发内实施类调用达此数算实施突发（缺省 3）' },
      probeWindowMs: { type: 'number', description: 'probe-before-action：首个实施动作前回看多久算「行动前探测」（缺省 15 分钟）' },
      claimWindowMs: { type: 'number', description: 'claim-vs-evidence：观测窗口 ms（缺省 6 小时）' },
      minArranged: { type: 'number', description: 'claim-vs-evidence：窗口内至少多少条「自我安排」自述才判定（缺省 5）' },
      claimCheckIntervalMs: { type: 'number', description: 'claim-vs-evidence：两次检查最小间隔 ms（缺省 5 分钟）' },
      threshold: { type: 'number', description: 'finding 证据阈值（缺省插件配置）' },
      polarity: { type: 'string', enum: ['violation-refutes', 'violation-supports'], description: '假设极性（2026-09-17）：violated 事件对**这条假设**意味着什么。violation-refutes = 主张「我会做 X」（缺省；read-repeat 除外）；violation-supports = 主张「我倾向做 X」（自省缺陷型，如 read-repeat）。不填 = 按探针 kind 取默认并物化写入。' },
      source: { type: 'string', description: '来源（缺省 alice）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          status: { type: 'string' },
          threshold: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? '已添加自我假设 [' + v.id + ']（' + v.status + '，阈值 ' + v.threshold + '）——插件开始被动采证。' : '添加失败：' + String(v.error ?? '') }],
    },
    async execute(args: { statement: string; prediction: string; kind: ProbeKind; polarity?: Polarity; tool?: string; failureRateAbove?: number; minSamples?: number; windowMs?: number; repeatCount?: number; minSteps?: number; burstGapMs?: number; planWindowMs?: number; minActions?: number; probeWindowMs?: number; claimWindowMs?: number; minArranged?: number; claimCheckIntervalMs?: number; threshold?: number; source?: string }) {
      const state = loadState(statePath)
      const threshold = args.threshold ?? config.findingThreshold
      // 极性物化（2026-09-17）：显式声明优先；未声明则把该探针的默认值**写进数据**——
      // 「极性住在数据里」是本次修复的核心，不能继续靠消费方回退到隐式默认表。
      const probe: Probe = { kind: args.kind, polarity: args.polarity ?? resolvePolarity({ kind: args.kind }) }
      if (args.tool !== undefined) probe.tool = args.tool
      if (args.failureRateAbove !== undefined) probe.failureRateAbove = args.failureRateAbove
      if (args.minSamples !== undefined) probe.minSamples = args.minSamples
      if (args.windowMs !== undefined) probe.windowMs = args.windowMs
      if (args.repeatCount !== undefined) probe.repeatCount = args.repeatCount
      if (args.minSteps !== undefined) probe.minSteps = args.minSteps
      if (args.burstGapMs !== undefined) probe.burstGapMs = args.burstGapMs
      if (args.planWindowMs !== undefined) probe.planWindowMs = args.planWindowMs
      if (args.minActions !== undefined) probe.minActions = args.minActions
      if (args.probeWindowMs !== undefined) probe.probeWindowMs = args.probeWindowMs
      if (args.claimWindowMs !== undefined) probe.claimWindowMs = args.claimWindowMs
      if (args.minArranged !== undefined) probe.minArranged = args.minArranged
      if (args.claimCheckIntervalMs !== undefined) probe.claimCheckIntervalMs = args.claimCheckIntervalMs
      const h: Hypothesis = {
        id: nextId(),
        statement: args.statement,
        prediction: args.prediction,
        probe,
        threshold,
        status: 'active',
        evidence: [],
        createdAt: nowIso(),
        updatedAt: nowIso(),
        source: args.source ?? 'alice',
      }
      state.hypotheses.push(h)
      saveState(statePath, state)
      return { ok: true, id: h.id, status: h.status, threshold }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'selftest_list',
    description: '列出自我假设库：每个假设的陈述/预测/探针/极性/证据方向/证据数/状态，并顺带做存量极性体检。可过滤状态（active/finding/confirmed/refuted）。方向由 polarity.ts 统一判定（支持/反对/混杂/未知）——confirmed 却「证据指向不成立」的行会标 ⚠极性存疑（裁决时方向读反了，该重新裁定）。',
    parameters: {
      status: { type: 'string', enum: ['active', 'finding', 'confirmed', 'refuted', 'archived'], description: '状态过滤' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          total: { type: 'number' },
          /** 存量极性体检结论：状态=confirmed 但证据方向为「反对」或「混杂」的条数（>0 ⇒ 待复核） */
          polaritySuspects: { type: 'number' },
          hypotheses: { type: 'json' },
        },
      },
      render: (_a: unknown, v: any) => {
        const hs = v.hypotheses ?? []
        if (hs.length === 0) {
          return [{ type: 'text', text: '自我假设库为空——先 selftest_add 一条可证伪猜想，让插件在真实工具调用中自动采证。' }]
        }
        const lines = hs.map((h: any) => {
          const statusMark = h.status === 'finding' ? '⚠FINDING' : h.status === 'confirmed' ? '✓' : h.status === 'refuted' ? '✗' : '·'
          const dir = h.direction ?? {}
          const dirMark = dir.direction === 'support' ? '支持' : dir.direction === 'refute' ? '反对' : dir.direction === 'mixed' ? '混杂' : '未知'
          const suspect = h.polaritySuspect === true ? ' ⚠极性存疑（状态与证据方向相悖）' : ''
          return `${statusMark} [${h.id}] ${h.statement}\n   预测: ${h.prediction}\n   探针: ${h.probe?.kind ?? '?'}（极性 ${h.probe?.polarity ?? '默认'}） | 证据 ${h.evidence?.length ?? 0}/${h.threshold} | 方向 ${dirMark}（支持 ${dir.support ?? 0}/反对 ${dir.refute ?? 0}${dir.legacyAssumed > 0 ? `/推定 ${dir.legacyAssumed}` : ''}） | ${h.status}${suspect}`
        })
        const head = v.polaritySuspects > 0
          ? `⚠ 极性存疑 ${v.polaritySuspects} 条——状态与证据方向相悖，疑似裁决时把方向读反了 ⇒ 逐条处置：refine（重建断言、清旧证据重新采证）或 refute（淘汰）。\n`
          : ''
        return [{ type: 'text', text: head + `自我假设库（${hs.length}）\n` + lines.join('\n') }]
      },
    },
    async execute(args: { status?: string }) {
      const state = loadState(statePath)
      let hs = state.hypotheses
      if (args.status !== undefined) hs = hs.filter((h) => h.status === args.status)
      const enriched = hs.map((h) => {
        const direction: DirectionReport = computeDirection(h.evidence, h.probe)
        // 存量极性体检（2026-09-17）：状态说「成立」而证据方向是「反对」或「混杂」= 待复核指纹。
        // 只算 refute 会漏掉「confirmed 但证据两个方向都有」这一类（实测 h-mu0qvlm1-2 就是漏网的）。
        const polaritySuspect = h.status === 'confirmed' && direction.direction !== 'support'
        return { ...h, direction, polaritySuspect }
      })
      return {
        ok: true,
        total: enriched.length,
        polaritySuspects: enriched.filter((h) => h.polaritySuspect).length,
        hypotheses: JSON.parse(JSON.stringify(enriched)),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'selftest_findings',
    description: '列出待裁决的 finding（证据达阈值的 active 假设）。⚠ finding 只说明「证据够了」，**方向要另看**：证据指向支持 ⇒ confirm（布线）/ 指向反对 ⇒ refute（淘汰）/ 混杂 ⇒ refine（细化判定条件）——每条 finding 附 direction 判定，按它裁决。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          count: { type: 'number' },
          findings: { type: 'json' },
        },
      },
      render: (_a: unknown, v: any) => {
        const fs = v.findings ?? []
        if (fs.length === 0) return [{ type: 'text', text: '暂无待裁决 finding——没有自我猜想的证据达阈值。' }]
        const lines = fs.map((f: any) => {
          const dir = f.direction ?? {}
          return `⚠ [${f.id}] ${f.statement}\n   证据 ${f.evidence?.length ?? 0}/${f.threshold} 条 | ${dir.text ?? '方向未知'}`
        })
        return [{ type: 'text', text: `待裁决 finding（${fs.length}）——证据已足，**按方向裁决**：\n` + lines.join('\n') }]
      },
    },
    async execute() {
      const state = loadState(statePath)
      const findings = state.hypotheses.filter((h) => h.status === 'finding')
      return {
        ok: true,
        count: findings.length,
        findings: JSON.parse(JSON.stringify(findings.map((h) => ({ ...h, direction: computeDirection(h.evidence, h.probe) })))),
      }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'selftest_review',
    description: '裁决一条假设：verdict=confirm 标 confirmed 并生成 AGENTS.md 规则草案（供布线）；refute 标 refuted（淘汰）；refine 改 statement/阈值/极性后回到 active 重新采证（旧证据清空）。裁决前会用 polarity.ts 算证据方向：当裁决动作与方向相悖（如方向=反对却 confirm）时返回 polarityWarning —— **只提示不阻断**，决策权归爱丽丝（§2.1）。',
    parameters: {
      id: { type: 'string', required: true, description: '假设 id' },
      verdict: { type: 'string', required: true, enum: ['confirm', 'refute', 'refine'], description: '裁决' },
      ruleDraft: { type: 'string', description: 'confirm 时：AGENTS.md 规则草案' },
      newStatement: { type: 'string', description: 'refine 时：新陈述' },
      newThreshold: { type: 'number', description: 'refine 时：新阈值' },
      polarity: { type: 'string', enum: ['violation-refutes', 'violation-supports'], description: '修正假设极性（violation-refutes=主张「我会做 X」；violation-supports=自省缺陷型「我倾向做 X」）——refine 重建断言时通常要一起校正' },
      resolution: { type: 'string', description: '裁决记录' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          id: { type: 'string' },
          status: { type: 'string' },
          evidence: { type: 'number' },
          direction: { type: 'string' },
          polarityWarning: { type: 'string' },
          wired: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{
        type: 'text',
        text: v.ok
          ? ('裁决完成：[' + v.id + '] → ' + v.status + '（证据 ' + v.evidence + ' 条；方向 ' + String(v.direction ?? '未知') + '）'
            + (v.wired ? ' ⚡ 已自动布线 AGENTS.md' : '')
            + (v.polarityWarning ? '\n' + v.polarityWarning : ''))
          : '裁决失败：' + String(v.error ?? ''),
      }],
    },
    async execute(args: { id: string; verdict: 'confirm' | 'refute' | 'refine'; ruleDraft?: string; newStatement?: string; newThreshold?: number; polarity?: Polarity; resolution?: string }) {
      const state = loadState(statePath)
      const h = state.hypotheses.find((x) => x.id === args.id)
      if (h === undefined) return { ok: false, error: `hypothesis ${args.id} not found` }
      if (h.status !== 'finding' && args.verdict === 'confirm') {
        return { ok: false, error: `only finding can be confirmed (current: ${h.status})` }
      }
      h.updatedAt = nowIso()
      // 方向判定（2026-09-17）：裁决前先看清证据指向什么，与动作相悖就响亮提示（不阻断）
      const dir = computeDirection(h.evidence, h.probe)
      let polarityWarning: string | null = null
      if (args.verdict !== 'refine' && contradictsDirection(args.verdict, dir.direction)) {
        polarityWarning = `⚠ 护栏提示：${dir.text} —— 而你选择了 ${args.verdict}。`
          + (dir.direction === 'refute'
            ? '若主张本就该被证伪（「我不会 X」型），正确动作通常是 refute 或 refine（改写断言后重新采证）。'
            : '若已确认要逆方向裁定，请在 resolution 写明理由（本次已照办）。')
      }
      if (args.polarity !== undefined) h.probe.polarity = args.polarity
      let wired: { wired: boolean; file?: string; error?: string } | null = null
      const note = (base: string): string => polarityWarning === null ? base : base + ' ｜ ' + polarityWarning
      if (args.verdict === 'confirm') {
        h.status = 'confirmed'
        h.resolution = note(args.resolution ?? 'confirmed by evidence')
        h.note = args.ruleDraft ?? h.note
        // 自动布线（2026-09-06）：ruleDraft 非空 → 写入 AGENTS.md（五环「布线」自动化）
        if (args.ruleDraft !== undefined && args.ruleDraft.trim().length > 0) {
          wired = wireRuleToAgents(args.ruleDraft)
        }
      } else if (args.verdict === 'refute') {
        h.status = 'refuted'
        h.resolution = note(args.resolution ?? 'refuted by evidence')
      } else if (args.verdict === 'refine') {
        h.status = 'active'
        if (args.newStatement !== undefined) h.statement = args.newStatement
        if (args.newThreshold !== undefined) h.threshold = args.newThreshold
        h.evidence = [] // 重新采证
        h.resolution = args.resolution ?? 'refined, re-collecting evidence'
      }
      saveState(statePath, state)
      // ⚠ 输出必须 lossless JSON（2026-09-17 实测事故）：把 `polarityWarning` 写进对象再赋 `undefined`
      // 会让 `JSON.parse(JSON.stringify(v))` 与原值不等（键被 stringify 丢掉）⇒ 宿主判
      // `invalid output: value is not lossless JSON`（**execute 的副作用已落盘，只是返回值被拒**）。
      // 正确做法：可选键**不存在**，而不是「存在但为 undefined」。
      const out: { ok: boolean; id: string; status: string; evidence: number; direction: string; polarityWarning?: string; wired: { file: string } | null } = {
        ok: true,
        id: h.id,
        status: h.status,
        evidence: h.evidence.length,
        direction: dir.direction,
        wired: wired?.wired === true ? { file: wired.file ?? '' } : null,
      }
      if (polarityWarning !== null) out.polarityWarning = polarityWarning
      return out
    },
  }))

  ctx.effect(() => () => {
    // ctx.on 由 cordis 自动释放
  })

  logger.info('ready (self-test loop, findingThreshold=' + config.findingThreshold + ', mainSessionOnly=' + config.mainSessionOnly + ')')
}
