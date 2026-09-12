/**
 * claim-vs-evidence 探针的判定纯函数（2026-09-12 新增，AGENTS.md 5.17 事故配套传感器）
 *
 * ## 观测的失效模式：机制自述与实证不一致（假活）
 *
 * 现有四个探针（tool-failure-rate / read-repeat / plan-before-action / probe-before-action）
 * 全部只看「**我的调用行为**」——没有一个看「**我声称某机制在跑」与「该机制真的发生了」的一致性**。
 * 于是 2026-09-11~12 的感知圈停摆（两天 311 次跳过、29 小时零真实感知圈）在四个探针眼里
 * 完全隐形，而日志里的自述节律看起来健康（每 5 分钟「安排」一次）。
 *
 * ## 证据定义（取自真实 life-log 字段，可复核）
 *
 * - **自述（arranged）**：`summary` 含「自我安排」的条目 —— 机制在说「我安排了下一圈」
 * - **实证（triggered）**：`summary` 含「自我感知圈触发」的条目 —— 真实感知圈发生过
 *
 * 实测对照（同一份 life-log，按日聚合 arranged / triggered）：
 * ```
 * 09-06  143 / 6     09-07  11 / 6     09-10  14 / 8
 * 09-11  160 / 4  ←停摆   09-12  157 / 1  ←停摆（修复前）
 * ```
 * 停摆日的特征不是「实证为 0」，而是**窗口内自述密集却零真实触发**——故判据按窗口取，
 * 不取全量比值（全量比值会被历史健康期稀释，且引入无界状态）。
 *
 * ## 判据
 *
 * | 条件 | 结论 |
 * |---|---|
 * | arranged < minArranged | null（机制静默——属另一类失效，由停摆告警覆盖，不在本探针职责） |
 * | arranged ≥ minArranged 且 triggered === 0 | **violated**（假活：自述在跑、实证为零） |
 * | arranged ≥ minArranged 且 triggered ≥ 1 | **survived**（自述与实证一致） |
 *
 * 纯函数：无 IO、无时间依赖（窗口起点由调用方传入），便于离线单测与尸体测试。
 */

/** claim-vs-evidence 默认值（可被探针字段覆盖） */
export const CLAIM_DEFAULTS = {
  /** 观测窗口（ms）：默认 6 小时——短于停摆时长（29h）足以暴露，长于正常感知周期（默认 180min）避免误报 */
  windowMs: 6 * 60 * 60 * 1000,
  /** 窗口内至少多少条自述才值得判定（防单条噪声） */
  minArranged: 5,
} as const

/** 自述标记：机制声称「我已安排下一圈」 */
export const CLAIM_MARKER = '自我安排'
/** 实证标记：真实感知圈触发 */
export const EVIDENCE_MARKER = '自我感知圈触发'

/** life-log 的一行（只取判定所需字段） */
export interface LifeLogEntry {
  at: string
  kind: string
  summary: string
}

/** 窗口内计数结果 */
export interface ClaimEvidenceCounts {
  arranged: number
  triggered: number
  windowMs: number
}

/** 一条 claim-vs-evidence 证据 */
export interface ClaimEvidence {
  arranged: number
  triggered: number
  windowMs: number
  minArranged: number
  verdict: 'violated' | 'survived'
  sample: string[]
}

/**
 * 解析一行 life-log（纯函数）。
 * @param line - JSONL 单行
 * @returns 判定所需字段；非法行返回 null（不抛错——损坏行不得让探针整体失效）
 */
export function parseLifeLogLine(line: string): LifeLogEntry | null {
  const trimmed = line.trim()
  if (trimmed === '') return null
  try {
    const doc = JSON.parse(trimmed) as { at?: unknown; kind?: unknown; summary?: unknown }
    if (typeof doc.at !== 'string' || typeof doc.summary !== 'string') return null
    return { at: doc.at, kind: typeof doc.kind === 'string' ? doc.kind : '', summary: doc.summary }
  } catch {
    return null
  }
}

/**
 * 在 [windowStartMs, nowMs] 内统计自述与实证条数（纯函数，非法行与越窗条目均忽略）。
 * @param lines - life-log 原始行
 * @param windowStartMs - 窗口起点（ms）
 * @param nowMs - 窗口终点（ms）
 * @returns 计数结果
 */
export function countLifeCycleClaims(lines: string[], windowStartMs: number, nowMs: number): ClaimEvidenceCounts {
  let arranged = 0
  let triggered = 0
  for (const line of lines) {
    const entry = parseLifeLogLine(line)
    if (entry === null) continue
    const at = Date.parse(entry.at)
    if (Number.isNaN(at) || at < windowStartMs || at > nowMs) continue
    if (entry.summary.includes(CLAIM_MARKER)) arranged += 1
    if (entry.summary.includes(EVIDENCE_MARKER)) triggered += 1
  }
  return { arranged, triggered, windowMs: nowMs - windowStartMs }
}

/**
 * 判定窗口内的自述与实证是否一致。
 * @param counts - countLifeCycleClaims 的结果
 * @param options - minArranged 覆盖
 * @param samples - 可选：自述样本（写入证据，供裁决时人工复核）
 * @returns 证据对象；无需判定时返回 null
 */
export function decideClaimEvidence(
  counts: ClaimEvidenceCounts,
  options: { minArranged?: number } = {},
  samples: string[] = [],
): ClaimEvidence | null {
  const minArranged = options.minArranged ?? CLAIM_DEFAULTS.minArranged
  if (counts.arranged < minArranged) return null
  const base = {
    arranged: counts.arranged,
    triggered: counts.triggered,
    windowMs: counts.windowMs,
    minArranged,
    sample: samples.slice(0, 3),
  }
  return counts.triggered === 0
    ? { ...base, verdict: 'violated' }
    : { ...base, verdict: 'survived' }
}
