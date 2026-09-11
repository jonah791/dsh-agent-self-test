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

/** 探针类型 */
export type ProbeKind = 'tool-failure-rate' | 'read-repeat' | 'plan-before-action' | 'probe-before-action'

/** 探针定义（声明式条件观察器） */
export interface Probe {
  kind: ProbeKind
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
    // 方向感知（2026-09-11）：证据含两种 verdict——survived（经受住检验）与 violated（违规）。
    // 通知文案必须区分，否则「假设被证实」会被当成「假设出问题」，裁决方向就反了。
    const survivedCount = h.evidence.filter((e) => (e.detail as { verdict?: string } | undefined)?.verdict === 'survived').length
    const violatedCount = h.evidence.length - survivedCount
    const promoting = h.evidence[h.evidence.length - 1]
    const promotedBySurvival = (promoting?.detail as { verdict?: string } | undefined)?.verdict === 'survived'
    const headline = promotedBySurvival ? '✓ 假设经受住检验' : '⚠ finding 浮现'
    const tally = violatedCount > 0 && survivedCount > 0
      ? `（证据 ${h.evidence.length}/${h.threshold} 条：经受住 ${survivedCount} / 违规 ${violatedCount}——**证据方向混杂，建议 refine 细化判定条件**）`
      : (survivedCount > 0
        ? `（经受住检验 ${survivedCount}/${h.threshold} 次）`
        : `（违规证据 ${h.evidence.length}/${h.threshold} 条）`)
    const text = '[self-test] ' + headline + '：' + h.statement + tally +
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
                detail: { path, readsInWindow: inWindow, windowMs },
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
    description: '添加一条可证伪自我假设：statement（关于自己行为的可证伪陈述）+ prediction（可观测预测）+ probe（探针：kind=tool-failure-rate 观测某工具失败率；kind=read-repeat 观测重复读同一文件；kind=plan-before-action 观测复杂多步任务前是否先 todo_write 规划；kind=probe-before-action 观测实施突发前是否先做证伪探测——AGENTS.md 5.9 传感器）。插件在真实工具调用中被动采证，证据达 threshold 转 finding 供裁决。',
    parameters: {
      statement: { type: 'string', required: true, description: '可证伪陈述' },
      prediction: { type: 'string', required: true, description: '可观测预测' },
      kind: { type: 'string', required: true, enum: ['tool-failure-rate', 'read-repeat', 'plan-before-action', 'probe-before-action'], description: '探针类型' },
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
      threshold: { type: 'number', description: 'finding 证据阈值（缺省插件配置）' },
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
    async execute(args: { statement: string; prediction: string; kind: ProbeKind; tool?: string; failureRateAbove?: number; minSamples?: number; windowMs?: number; repeatCount?: number; minSteps?: number; burstGapMs?: number; planWindowMs?: number; minActions?: number; probeWindowMs?: number; threshold?: number; source?: string }) {
      const state = loadState(statePath)
      const threshold = args.threshold ?? config.findingThreshold
      const probe: Probe = { kind: args.kind }
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
    description: '列出自我假设库：每个假设的陈述/预测/探针/证据数/状态。可过滤状态（active/finding/confirmed/refuted）。用于查看正在检验的自我猜想进度。',
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
          return `${statusMark} [${h.id}] ${h.statement}\n   预测: ${h.prediction}\n   探针: ${h.probe?.kind ?? '?'} | 证据 ${h.evidence?.length ?? 0}/${h.threshold} | ${h.status}`
        })
        return [{ type: 'text', text: `自我假设库（${hs.length}）\n` + lines.join('\n') }]
      },
    },
    async execute(args: { status?: string }) {
      const state = loadState(statePath)
      let hs = state.hypotheses
      if (args.status !== undefined) hs = hs.filter((h) => h.status === args.status)
      return { ok: true, total: hs.length, hypotheses: JSON.parse(JSON.stringify(hs)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'selftest_findings',
    description: '列出待裁决的 finding（证据达阈值的 active 假设）。finding = 自我猜想被真实行为证实的信号——用 selftest_review 裁决（confirm 布线 / refute 淘汰 / refine 细化）。',
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
        if (fs.length === 0) return [{ type: 'text', text: '暂无待裁决 finding——没有自我猜想被证据证实到阈值。' }]
        const lines = fs.map((f: any) => `⚠ [${f.id}] ${f.statement}\n   证据 ${f.evidence?.length ?? 0} 条，最近: ${f.evidence?.slice(-3).map((e: any) => e.kind).join(',') ?? '?'}`)
        return [{ type: 'text', text: `待裁决 finding（${fs.length}）——证据已足，该裁决了:\n` + lines.join('\n') }]
      },
    },
    async execute() {
      const state = loadState(statePath)
      const findings = state.hypotheses.filter((h) => h.status === 'finding')
      return { ok: true, count: findings.length, findings: JSON.parse(JSON.stringify(findings)) }
    },
  }))

  ctx.tools.register(defineTool({
    name: 'selftest_review',
    description: '裁决一条 finding：verdict=confirm 把被证实的模式标 confirmed 并生成 AGENTS.md 规则草案（供布线）；refute 标 refuted（淘汰未被证实的猜想）；refine 改 statement/阈值后回到 active 继续采证。',
    parameters: {
      id: { type: 'string', required: true, description: '假设 id' },
      verdict: { type: 'string', required: true, enum: ['confirm', 'refute', 'refine'], description: '裁决' },
      ruleDraft: { type: 'string', description: 'confirm 时：AGENTS.md 规则草案' },
      newStatement: { type: 'string', description: 'refine 时：新陈述' },
      newThreshold: { type: 'number', description: 'refine 时：新阈值' },
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
          wired: { type: 'json' },
          error: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => [{ type: 'text', text: v.ok ? ('裁决完成：[' + v.id + '] → ' + v.status + '（证据 ' + v.evidence + ' 条）' + (v.wired ? ' ⚡ 已自动布线 AGENTS.md' : '')) : '裁决失败：' + String(v.error ?? '') }],
    },
    async execute(args: { id: string; verdict: 'confirm' | 'refute' | 'refine'; ruleDraft?: string; newStatement?: string; newThreshold?: number; resolution?: string }) {
      const state = loadState(statePath)
      const h = state.hypotheses.find((x) => x.id === args.id)
      if (h === undefined) return { ok: false, error: `hypothesis ${args.id} not found` }
      if (h.status !== 'finding' && args.verdict === 'confirm') {
        return { ok: false, error: `only finding can be confirmed (current: ${h.status})` }
      }
      h.updatedAt = nowIso()
      let wired: { wired: boolean; file?: string; error?: string } | null = null
      if (args.verdict === 'confirm') {
        h.status = 'confirmed'
        h.resolution = args.resolution ?? 'confirmed by evidence'
        h.note = args.ruleDraft ?? h.note
        // 自动布线（2026-09-06）：ruleDraft 非空 → 写入 AGENTS.md（五环「布线」自动化）
        if (args.ruleDraft !== undefined && args.ruleDraft.trim().length > 0) {
          wired = wireRuleToAgents(args.ruleDraft)
        }
      } else if (args.verdict === 'refute') {
        h.status = 'refuted'
        h.resolution = args.resolution ?? 'refuted by evidence'
      } else if (args.verdict === 'refine') {
        h.status = 'active'
        if (args.newStatement !== undefined) h.statement = args.newStatement
        if (args.newThreshold !== undefined) h.threshold = args.newThreshold
        h.evidence = [] // 重新采证
        h.resolution = args.resolution ?? 'refined, re-collecting evidence'
      }
      saveState(statePath, state)
      return { ok: true, id: h.id, status: h.status, evidence: h.evidence.length, wired: wired?.wired === true ? { file: wired.file ?? '' } : null }
    },
  }))

  ctx.effect(() => () => {
    // ctx.on 由 cordis 自动释放
  })

  logger.info('ready (self-test loop, findingThreshold=' + config.findingThreshold + ', mainSessionOnly=' + config.mainSessionOnly + ')')
}
