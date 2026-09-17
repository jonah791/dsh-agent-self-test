/**
 * wiring.ts — 自动布线的**幂等合并**与**预算守卫**（纯函数，可离线单测）。
 *
 * 事故（2026-09-16 首次 / 2026-09-17 重演）：`selftest_review` 的自动布线把 marker 块
 * **整体替换**（`full.replace(/start[\s\S]*end/, block)`）——它的隐含假设是「块里只有一条规则」，
 * 而块是**累积**的（每确认一条猜想追加一条）。后果：第二次 confirm 抹掉第一次的规则，
 * 且只有**字节数反降**才暴露（65,151 → 64,795）。两次事故各丢一条规则。
 *
 * 本模块把布线改成 **upsert（按归一化内容合并）+ 预算守卫（超限 fail-loud）**：
 * - 已有同规则（归一化后包含）⇒ `exists`：一字不写（幂等，不产生重复）
 * - 新规则 ⇒ `added`：追加在块尾，既有条目顺序与内容**原样保留**
 * - 写入后超字节预算 ⇒ `rejected`：**拒绝写盘**并回报（宁可拒写，不可静默截断尾部）
 */

/** 归一化：折叠空白、去首尾——「同一条规则」的判定输入 */
export function normalizeRule(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export type UpsertAction = 'added' | 'exists'

export interface UpsertResult {
  /** 合并后的块内文本（不含 marker 行） */
  inner: string
  action: UpsertAction
}

/**
 * 把 `draft` 合并进既有块内文本（**只增不减**）。
 *
 * 判定：归一化后既有块**已包含** draft ⇒ `exists`（幂等跳过）。
 * 方向性是有意的：同主题的**不同措辞**会被判成 `added` 并追加——宁可「重复表述」，
 * 也不「丢失既有」（丢信息不可逆；重复只是冗余，人读时自会合并）。
 */
export function upsertRuleBlock(existingInner: string, draft: string): UpsertResult {
  const draftNorm = normalizeRule(draft)
  if (draftNorm === '') return { inner: existingInner, action: 'exists' }
  if (normalizeRule(existingInner).includes(draftNorm)) return { inner: existingInner, action: 'exists' }
  const head = existingInner.replace(/\s+$/, '')
  return { inner: head === '' ? draft.trim() : head + '\n' + draft.trim(), action: 'added' }
}

/** 字节预算裁决（fail-loud）：`allowed === false` 时调用方**不得写盘** */
export function checkBudget(nextContent: string, maxBytes: number): { allowed: boolean; bytes: number; headroom: number } {
  const bytes = new TextEncoder().encode(nextContent).length
  return { allowed: bytes <= maxBytes, bytes, headroom: maxBytes - bytes }
}

/** marker（唯一格式真源——写入与解析共用，避免两处各写一份字面量） */
export const MARKER_START = '<!-- dsh-agent-self-test:start -->'
export const MARKER_END = '<!-- dsh-agent-self-test:end -->'

/** 组装 marker 块 */
export function buildBlock(inner: string): string {
  return MARKER_START + '\n' + inner.replace(/\s+$/, '') + '\n' + MARKER_END
}

/** 抽取块内文本（无块 / 块序颠倒 ⇒ undefined） */
export function extractBlockInner(full: string): string | undefined {
  const start = full.indexOf(MARKER_START)
  const end = full.indexOf(MARKER_END)
  if (start === -1 || end === -1 || end < start) return undefined
  return full.slice(start + MARKER_START.length, end).replace(/^\s*\n/, '').replace(/\s+$/, '')
}

/** 用新的块内文本就地替换旧块；无块则追加到文件尾（返回整文件新内容） */
export function spliceBlock(full: string, inner: string): string {
  const block = buildBlock(inner)
  const start = full.indexOf(MARKER_START)
  const end = full.indexOf(MARKER_END)
  if (start !== -1 && end !== -1 && end > start) {
    return full.slice(0, start) + block + full.slice(end + MARKER_END.length)
  }
  return full.replace(/\n?\s*$/, '\n') + '\n' + block + '\n'
}
