/**
 * tool-failure-rate 探针的判定纯函数（2026-09-11 修复采证不对称）
 *
 * ## 修复动机（自指缺陷）
 *
 * 旧实现只在**失败**时采证（`isError && rate >= threshold`）→ 「X 是可靠的」这类假设
 * **永远采不到证据**：真值也无法被证实，只能烂在 active 状态并污染感知圈报告
 * （实测 2026-09-11：2 条 active 假设证据恒 0，进化核心报「有 active 假设但证据 0」）。
 *
 * 本质：自指引擎把「证据」错当成了「违规计数」。可证伪性要求两种证据都能采——
 * - **violated**：失败率越过阈值 = 证伪方向的证据（原行为，保留）
 * - **survived**：样本达检查点且失败率未越阈值 = 证实方向的证据（本次新增）
 *
 * 缺了证实方向，「某工具可靠」「某行为不发生」这一类假设在结构上不可能收敛，
 * 引擎只能无限期挂着它们——这不是耐心，是传感器失明。
 *
 * ## 设计
 *
 * 纯函数（无 IO、无状态、无时间依赖）——判定只依赖调用方维护的统计快照，
 * 便于离线单测（tests/failure-rate.test.mjs）。检查点用「调用数是 minSamples 的整数倍」
 * 表达，避免引入需要持久化的 nextCheckpoint 状态（重启即归零的隐式状态正是 AGENTS.md 5.12 批过的坑）。
 */

/** 滚动统计快照（由调用方维护，跨工具调用累积） */
export interface FailureRateStats {
  calls: number
  failures: number
}

/** tool-failure-rate 默认值（可被探针字段覆盖） */
export const FAILURERATE_DEFAULTS = {
  /** 失败率阈值：达到或超过即记证伪证据 */
  threshold: 0.3,
  /** survived 检查点间隔（调用数）——样本够多才有资格谈「经受住检验」 */
  minSamples: 20,
} as const

export interface FailureRateOptions {
  threshold?: number
  minSamples?: number
}

/** 一条失败率证据（verdict 标明方向，供裁决区分「经受住」与「违规」） */
export interface FailureRateEvidence {
  tool: string
  calls: number
  failures: number
  rate: number
  threshold: number
  minSamples: number
  verdict: 'violated' | 'survived'
}

/** 保留三位小数（证据可读性；判定仍用原始比值） */
function round3(value: number): number {
  return Number(value.toFixed(3))
}

/**
 * 判定单个工具调用的采证结果。
 *
 * @param tool - 工具名（写入证据，便于裁决时定位）
 * @param stats - **已含**本次调用的滚动统计快照（调用方先自增再调用）
 * @param isError - 本次调用是否失败
 * @param options - threshold / minSamples 覆盖
 * @returns 证据对象；无证据时 null
 *
 * 判定顺序：先看证伪（违规永远值得记账），再看证实（只在检查点上报，防刷屏）。
 */
export function decideFailureRateEvidence(
  tool: string,
  stats: FailureRateStats,
  isError: boolean,
  options: FailureRateOptions = {},
): FailureRateEvidence | null {
  const threshold = options.threshold ?? FAILURERATE_DEFAULTS.threshold
  const minSamples = options.minSamples ?? FAILURERATE_DEFAULTS.minSamples
  const calls = stats.calls
  const failures = stats.failures
  if (calls <= 0) return null
  const rate = failures / calls
  const base = { tool, calls, failures, rate: round3(rate), threshold, minSamples }

  // 证伪方向：本次失败且滚动失败率已达阈值
  if (isError && rate >= threshold) return { ...base, verdict: 'violated' }

  // 证实方向：跨过检查点（调用数为 minSamples 整数倍）且失败率仍低于阈值
  if (calls % minSamples === 0 && rate < threshold) return { ...base, verdict: 'survived' }

  return null
}
