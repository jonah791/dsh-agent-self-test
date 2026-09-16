/**
 * plan-before-action 突发检测纯状态机（2026-08-30 从 apply 闭包抽出，可单测）
 *
 * 观测「复杂多步任务（连续工具调用突发）前是否先 todo_write 规划」：
 * - 突发 = 连续工具调用 run，相邻间隔 < burstGapMs（默认 60s）
 * - 突发起点判定：突发开始前 planWindowMs（默认 3 分钟）内出现过 todo_write = hadPlan
 * - 证据条件（双路径，2026-09-17 · t-bede2fab）：突发 calls ≥ minSteps（默认 5）且 ——
 *     ① hadPlan=false 且 failures ≥ 1 ⇒ `verdict: 'violated'`（无规划且撞墙）
 *     ② hadPlan=true  且 failures == 0 ⇒ `verdict: 'survived'`（有规划且顺利 = **对照组**）
 *     其余形态（无规划零失败 / 有规划撞墙）⇒ 不记（无判据，诚实留白）
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
   * 探针层事件方向（canonical 字段名 = `verdict`，与 failure-rate / claim-vs-evidence / probe-before-action 统一）：
   *   violated = 无规划突发且撞墙（≥1 失败）；survived = 有规划突发且零失败（2026-09-17 补，任务 t-bede2fab）
   * 注意：这是**事件属性**；它对某条假设是支持还是反对，由该假设的 polarity 决定（见 polarity.ts）。
   * ⚠ `hadPlan` 与 `verdict` 必须自洽：violated ⇒ hadPlan=false；survived ⇒ hadPlan=true
   *   （旧实现把 `hadPlan: false` 写死——违规路径下恰好成立，补 survived 后会自相矛盾，故改为读真实状态）。
   */
  verdict: 'violated' | 'survived'
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
      const emit = (verdict: 'violated' | 'survived'): void => {
        if (evidence !== null || tracker.currentBurst === null) return
        const b = tracker.currentBurst
        evidence = {
          burstStartTs: new Date(b.startTs).toISOString(),
          calls: b.calls,
          failures: b.failures,
          hadPlan: b.hadPlan,
          verdict,
        }
        b.evidenced = true
      }
      /**
       * 双路径结算（2026-09-17，任务 t-bede2fab）：
       * 旧实现**只有违规路径**（无规划 + ≥1 失败）⇒ 合规突发（有规划且零失败）永不产证据，
       * 于是「我会先规划」「不规划 ⇒ 更易失败」这类主张在结构上**不可判**（无对照组则无比较；
       * 实测已有 2 条假设因此被判 refute）。补给 survived 路径后同一探针能双向采证
       * （对照 probe.ts 2026-09-17 / failure-rate 的 minSamples 检查点）。
       * 诚实留白：**无规划但零失败 ⇒ 两条路径都不记**（既不合规、也没撞墙 ⇒ 无判据）；
       *           **有规划但撞墙 ⇒ 同样不记**（对照组里撞墙不能证伪「规划有价值」）。
       */
      const tryEmit = (): void => {
        const b = tracker.currentBurst
        if (b === null || b.evidenced || b.calls < minSteps) return
        if (!b.hadPlan && b.failures >= 1) { emit('violated'); return }
        if (b.hadPlan && b.failures === 0) { emit('survived'); return }
      }

      const isNew = tracker.currentBurst === null || now - tracker.currentBurst.lastTs > burstGapMs
      if (isNew) {
        tryEmit()   // 结算上一突发（若已达标且未记过证据）
        // 新突发起点：检查规划窗口内是否有 todo_write
        const hadPlan = tracker.lastTodoTs > 0 && (now - tracker.lastTodoTs) <= planWindowMs
        tracker.currentBurst = { startTs: now, lastTs: now, calls: 1, failures: isError ? 1 : 0, hadPlan, evidenced: false }
      } else {
        const b = tracker.currentBurst!
        b.lastTs = now
        b.calls += 1
        if (isError) b.failures += 1
      }
      // 突发达标即结算（实时，不等到下个突发；每突发最多一条证据）
      tryEmit()
      return evidence
    },
  }
  return tracker
}
