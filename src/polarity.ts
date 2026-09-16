/**
 * 探针极性 · 方向判定（2026-09-17，任务 t-56b052fb）
 *
 * 缺陷根因（一手取证）：五族探针里只有两族（tool-failure-rate / claim-vs-evidence）在证据里显式写方向；
 *   probe-before-action 写的是 `kind`（词形还不一样：violation ≠ violated）；read-repeat / plan-before-action
 *   干脆不写 —— 方向靠「这类探针只在违规时发射」的**隐式约定** ⇒ 任何消费方（通知文案 / selftest_findings /
 *   裁决 / 体检）都得自己猜。实测后果：4 条「我会做 X」型假设被**违规证据**判成了 confirmed —— 方向反了。
 *
 * 两层语义必须分开（本模块的核心裁决）：
 *   ① 探针层 verdict：探针盯的规范被 violated（违反）还是 survived（经受住）—— **事件属性**
 *   ② 假设层 polarity：该事件对**这条假设**意味着什么 —— **假设属性**
 *        violation-refutes（默认）：假设主张「我会做 X」⇒ violated 是反对证据
 *        violation-supports       ：假设主张「我倾向做 X」（自省缺陷）⇒ violated 是支持证据
 *   例：read-repeat 的 violated（又重复读了）对「我不该重复读」是反对，对「我倾向于重复读」是支持。
 *   同一份证据、极性不同、裁决方向相反 —— 所以极性必须显式住在数据里，不能住在人的脑子里。
 *
 * 纯模块：无 IO、无时间依赖，便于离线单测（tests/polarity.test.mjs）。
 */

export type ProbeKind = 'tool-failure-rate' | 'read-repeat' | 'plan-before-action' | 'probe-before-action' | 'claim-vs-evidence'

/** 探针层事件方向（canonical 字段 = 证据 `detail.verdict`） */
export type EventVerdict = 'violated' | 'survived'

/** 假设层极性：violated 事件对这条假设意味着什么 */
export type Polarity = 'violation-refutes' | 'violation-supports'

/** 方向判定结果 */
export type Direction = 'support' | 'refute' | 'mixed' | 'unknown'

/**
 * 各探针的默认极性（缺省 = 该族假设的常见主张形态）：
 *   四族典型主张都是「我会做 X / X 是可靠的」⇒ violated 是**反对**
 *   read-repeat 典型主张是自省缺陷「我倾向于重复读」⇒ violated 是**支持**
 */
export const DEFAULT_POLARITY: Record<ProbeKind, Polarity> = {
  'tool-failure-rate': 'violation-refutes',
  'read-repeat': 'violation-supports',
  'plan-before-action': 'violation-refutes',
  'probe-before-action': 'violation-refutes',
  'claim-vs-evidence': 'violation-refutes',
}

/**
 * 历史证据的方向推定（2026-09-17 之前落库的证据没有 verdict 字段）：
 * 这三族当时**只有违规路径**（read-repeat 命中即记；plan-before-action 只在「无规划 + ≥1 失败」时记；
 * probe-before-action 的 survived 路径 2026-09-17 才补上）⇒ 旧数据一律推定为 violated。
 * 另两族历史上就写 verdict，缺失即**真的未知**（null = 诚实留白，不猜）。
 * 推定条数在 DirectionReport.legacyAssumed 里如实报出 —— 推定是显式的，不是暗的。
 */
export const LEGACY_UNLABELED_VERDICT: Record<ProbeKind, EventVerdict | null> = {
  'tool-failure-rate': null,
  'read-repeat': 'violated',
  'plan-before-action': 'violated',
  'probe-before-action': 'violated',
  'claim-vs-evidence': null,
}

/** 从证据 detail 读事件方向：认 canonical `verdict`，兼容旧 `kind` 字段（probe-before-action 曾用此字段） */
export function readEventVerdict(detail: unknown): EventVerdict | null {
  if (detail === null || typeof detail !== 'object') return null
  const v = (detail as { verdict?: unknown }).verdict
  if (v === 'violated' || v === 'survived') return v
  const k = (detail as { kind?: unknown }).kind
  if (k === 'violation' || k === 'violated') return 'violated'
  if (k === 'survived') return 'survived'
  return null
}

/** 解析假设的有效极性（显式声明优先，否则按探针 kind 取默认） */
export function resolvePolarity(probe: { kind: ProbeKind; polarity?: Polarity } | undefined): Polarity {
  const declared = probe?.polarity
  if (declared === 'violation-refutes' || declared === 'violation-supports') return declared
  const kind = probe?.kind
  if (kind !== undefined && DEFAULT_POLARITY[kind] !== undefined) return DEFAULT_POLARITY[kind]
  return 'violation-refutes'
}

export interface DirectionReport {
  direction: Direction
  /** 支持假设的证据条数 */
  support: number
  /** 反对假设的证据条数 */
  refute: number
  /** 无方向标签、按历史规则推定的条数（显式记账） */
  legacyAssumed: number
  /** 无方向标签且无从推定（真未知）的条数 */
  unknown: number
  polarity: Polarity
  /** 人读的一句话（含建议裁决动作） */
  text: string
}

const SUGGEST: Record<Direction, string> = {
  support: '建议 confirm',
  refute: '建议 refute',
  mixed: '方向混杂，建议 refine 细化判定条件',
  unknown: '无法判向（先补方向标签）',
}

/**
 * 从证据集 + 极性算方向（核心纯函数：所有消费方共用，禁止各自实现 —— §5.22 判据单一真源）
 */
export function computeDirection(
  evidence: readonly { detail?: unknown }[],
  probe: { kind: ProbeKind; polarity?: Polarity } | undefined,
): DirectionReport {
  const polarity = resolvePolarity(probe)
  let support = 0
  let refute = 0
  let legacyAssumed = 0
  let unknown = 0
  for (const ev of evidence) {
    let v = readEventVerdict(ev?.detail)
    if (v === null && probe !== undefined) {
      const legacy = LEGACY_UNLABELED_VERDICT[probe.kind]
      if (legacy !== undefined && legacy !== null) {
        v = legacy
        legacyAssumed += 1
      }
    }
    if (v === null) {
      unknown += 1
      continue
    }
    const supports = polarity === 'violation-supports' ? v === 'violated' : v === 'survived'
    if (supports) support += 1
    else refute += 1
  }
  const direction: Direction = support > 0 && refute > 0 ? 'mixed' : support > 0 ? 'support' : refute > 0 ? 'refute' : 'unknown'
  const headline = direction === 'support' ? '假设成立' : direction === 'refute' ? '假设不成立' : direction === 'mixed' ? '方向混杂' : '未知'
  const legacyNote = legacyAssumed > 0 ? `，其中 ${legacyAssumed} 条按历史规则推定（旧数据无方向标签）` : ''
  const unknownNote = unknown > 0 ? `，${unknown} 条无方向标签` : ''
  const text = `证据指向：${headline}（支持 ${support} / 反对 ${refute}${legacyNote}${unknownNote}；极性 ${polarity}）⇒ ${SUGGEST[direction]}`
  return { direction, support, refute, legacyAssumed, unknown, polarity, text }
}

/** 裁决动作与证据方向是否相悖（供 review 返响亮警告；**不阻断** —— 决策权归主体，§2.1） */
export function contradictsDirection(action: 'confirm' | 'refute', direction: Direction): boolean {
  if (direction === 'unknown') return false
  if (direction === 'mixed') return true
  return (action === 'confirm' && direction === 'refute') || (action === 'refute' && direction === 'support')
}
