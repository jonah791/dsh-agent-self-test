/**
 * plan-before-action 突发检测纯状态机（2026-08-30 从 apply 闭包抽出，可单测）
 *
 * 观测「复杂多步任务（连续工具调用突发）前是否先 todo_write 规划」：
 * - 突发 = 连续工具调用 run，相邻间隔 < burstGapMs（默认 60s）
 * - 突发起点判定：突发开始前 planWindowMs（默认 3 分钟）内出现过 todo_write = hadPlan
 * - 证据条件：突发 calls ≥ minSteps（默认 5）且 hadPlan=false 且 failures ≥ 1 —— 记一条证据
 * - 每个突发最多记一次证据（evidenced 防重复）
 *
 * 纯状态机：无 IO、无时间依赖（now 由调用方传入），便于离线单测。
 */

export interface BurstState {
  startTs: number
  lastTs: number
  calls: number
  failures: number
  hadPlan: boolean
  evidenced: boolean
}

export interface BurstEvidence {
  burstStartTs: string
  calls: number
  failures: number
  hadPlan: boolean
  /**
   * 探针层事件方向（canonical 字段名 = `verdict`，2026-09-17 补，任务 t-56b052fb）：
   * 本族当前**只有违规路径**（突发无规划 + ≥1 失败）⇒ 恒为 `violated`。
   * 显式写出来的意义：消费方不必再靠「这类探针只在违规时发射」的隐式约定猜方向。
   * ⚠ 缺口如实记账：合规路径（有规划且未撞墙）目前**不产证据** ⇒「我会先规划」类假设
   *   在本探针上仍不可确认（与 t-b2c2d903 给 probe-before-action 补 survived 前同款）。
   */
  verdict: 'violated'
}

export interface BurstOptions {
  /** 调用间隔超此值视为新突发（默认 60s） */
  burstGapMs?: number
  /** 突发判定最小连续调用数（默认 5） */
  minSteps?: number
  /** 突发起点前多长窗口内需出现 todo_write 才算「有规划」（默认 3 分钟） */
  planWindowMs?: number
}

export const BURST_DEFAULTS = {
  burstGapMs: 60 * 1000,
  minSteps: 5,
  planWindowMs: 3 * 60 * 1000,
}

export interface BurstTracker {
  /** 最近 todo_write 时间戳（规划信号） */
  lastTodoTs: number
  /** 当前突发 */
  currentBurst: BurstState | null
  /**
   * 推进一次工具调用；返回触发的证据详情（无触发返回 null）。
   * @param name 工具名（todo_write 会更新规划信号）
   * @param isError 本次调用是否失败
   * @param now 当前时间戳（调用方注入，保证可测）
   */
  feed(name: string, isError: boolean, now: number, options?: BurstOptions): BurstEvidence | null
}

/** 创建突发跟踪器（工厂：内部状态封装，feed 幂等地返回触发证据） */
export function createBurstTracker(): BurstTracker {
  const tracker: BurstTracker = {
    lastTodoTs: 0,
    currentBurst: null,
    feed(name, isError, now, options = {}) {
      const { burstGapMs, minSteps, planWindowMs } = { ...BURST_DEFAULTS, ...options }
      if (name === 'todo_write') tracker.lastTodoTs = now
      let evidence: BurstEvidence | null = null
      const emit = (): void => {
        if (evidence !== null) return
        evidence = {
          burstStartTs: new Date(tracker.currentBurst!.startTs).toISOString(),
          calls: tracker.currentBurst!.calls,
          failures: tracker.currentBurst!.failures,
          hadPlan: false,
          verdict: 'violated',
        }
        tracker.currentBurst!.evidenced = true
      }
      if (tracker.currentBurst === null || now - tracker.currentBurst.lastTs > burstGapMs) {
        // 新突发：判定上一突发（若已达标且未记过证据）
        if (tracker.currentBurst !== null && !tracker.currentBurst.evidenced
          && tracker.currentBurst.calls >= minSteps && !tracker.currentBurst.hadPlan && tracker.currentBurst.failures >= 1) {
          emit()
        }
        // 新突发起点：检查规划窗口内是否有 todo_write
        const hadPlan = tracker.lastTodoTs > 0 && (now - tracker.lastTodoTs) <= planWindowMs
        tracker.currentBurst = { startTs: now, lastTs: now, calls: 1, failures: isError ? 1 : 0, hadPlan, evidenced: false }
      } else {
        tracker.currentBurst.lastTs = now
        tracker.currentBurst.calls += 1
        if (isError) tracker.currentBurst.failures += 1
        // 突发达标即记证据（只记一次）
        if (!tracker.currentBurst.evidenced
          && tracker.currentBurst.calls >= minSteps && !tracker.currentBurst.hadPlan && tracker.currentBurst.failures >= 1) {
          emit()
        }
      }
      return evidence
    },
  }
  return tracker
}
