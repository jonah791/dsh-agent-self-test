/**
 * 同族假设的**重开簇**检测（2026-09-20，进化方向第二层「收敛治理」）
 *
 * 病根（一手读数）：同一主题被反复**新建**假设、而非 refine 旧判据 —— `plan-before-action` 一族
 * 重开了 7 次（h-mtfg7bmy-1 → h-mtfgltcj-2 → h-mtfj0qnc-1 → h-mtyenyo9-1 → h-mu1atc6v-1 →
 * h-mu2w71yv-1 → h-mu4judte-1），清一色被证伪；每建一条就重新采一轮证，代价白付，
 * 而 AGENTS.md 里那条规则照旧挂着（自带「仍 5/5 违规」的自认）。
 *
 * 治法（本模块）：不阻断、不代决 —— 在 `selftest_add` 入口把「这一族已经成了堆」**说出来**，
 * 逼出一个显式选择：refine 旧判据 / 承认不可测 / 转机制承载（提示/钩子）。
 * 机制只送达信号，决定权归主体（AGENTS.md §2.4 禁自动决策）。
 *
 * ⚠ 注意治的不是「被证伪」：一条假设被推翻是猜想-反驳的正常产物；治的是**同题反复重开**。
 *
 * 纯函数：无 IO、无时间依赖，便于离线单测（tests/cluster.test.mjs）。
 */

export interface ClusterMember {
  id: string
  status: string
  probe?: { kind?: string }
}

export interface ClusterReport {
  /** 探针族（kind） */
  kind: string
  /** 同族假设总数（含即将新建的那条之前的存量） */
  total: number
  /** 终态（refuted / confirmed）条数 —— 收敛判据只看它 */
  terminal: number
  refuted: number
  confirmed: number
  /** 活跃（active / finding）条数 */
  active: number
  /** 最近一条同族假设 id（指认「上一次重开」） */
  newestId: string | null
  /** 是否达到收敛阈值 */
  needsConvergence: boolean
  /** 人读的提示（未达阈值时为空串 —— 无话可说就不说） */
  text: string
}

/** 收敛阈值：同族终态假设 ≥ 此数即提示（默认 3） */
export const CLUSTER_THRESHOLD = 3

/**
 * 检测「新建这条假设之前，同族是否已成堆」。
 * @param hypotheses 现有全部假设（只读 id/status/probe.kind）
 * @param kind 即将新建的假设所属探针族
 * @param threshold 收敛阈值（缺省 CLUSTER_THRESHOLD）
 */
export function detectCluster(
  hypotheses: readonly ClusterMember[],
  kind: string,
  threshold: number = CLUSTER_THRESHOLD,
): ClusterReport {
  const same = hypotheses.filter((h) => h.probe?.kind === kind)
  const refuted = same.filter((h) => h.status === 'refuted').length
  const confirmed = same.filter((h) => h.status === 'confirmed').length
  const active = same.filter((h) => h.status === 'active' || h.status === 'finding').length
  const terminal = refuted + confirmed
  const newest = same.length > 0 ? same[same.length - 1] : undefined
  const needsConvergence = terminal >= threshold
  const text = needsConvergence
    ? `⚙ 收敛提示（第 2 层）：同族 \`${kind}\` 已有 ${terminal} 条终态假设（${refuted} 淘汰 / ${confirmed} 确认`
      + (active > 0 ? `，另有 ${active} 条活跃` : '')
      + `；最近一条 ${newest?.id ?? '?'}）。新建同族第 ${same.length + 1} 条前先显式回答：`
      + `① 该 **refine 旧判据**（可能是判据测错了东西）？② 还是承认它**不可测**？③ 还是**转机制承载**（提示/钩子）？`
      + `—— 不阻断，决定权归你。`
    : ''
  return {
    kind,
    total: same.length,
    terminal,
    refuted,
    confirmed,
    active,
    newestId: newest?.id ?? null,
    needsConvergence,
    text,
  }
}
