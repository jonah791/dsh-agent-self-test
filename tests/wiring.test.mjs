/**
 * wiring 单测（2026-09-17 · 自动布线「整块替换」缺陷修复）。
 *
 * 事故：`selftest_review` 的 confirm 自动布线用 `full.replace(/start[\s\S]*end/, block)`
 * **整体替换** marker 块 ⇒ 第二次 confirm 抹掉第一次的规则（块是累积的，实现却假设只有一条）。
 * 两次事故（09-16、09-17）各丢一条规则，且只有**字节数反降**才暴露。
 * 本套件把「只增不减 + 幂等 + 预算守卫」钉成可证伪判据（含**事故复刻**）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MARKER_START,
  MARKER_END,
  buildBlock,
  checkBudget,
  extractBlockInner,
  normalizeRule,
  spliceBlock,
  upsertRuleBlock,
} from '../lib/wiring.js'

const RULE_A = '**规则 A**：突发前先探一次（probe-before-action）。'
const RULE_B = '**规则 B**：编辑守卫的收口是 re-read → 重写，不是重试。'

/** 造一份含 marker 块的文件（块前有正文，用于验证「不碰块外」） */
function fileWith(inner) {
  return '# 文档正文\n\n一些既有段落。\n\n' + buildBlock(inner) + '\n\n<!-- 块后注释 -->\n'
}

test('normalizeRule：折叠空白、去首尾（同规则判定的输入）', () => {
  assert.equal(normalizeRule('  a\n\n b\t c  '), 'a b c')
  assert.equal(normalizeRule(''), '')
})

test('upsertRuleBlock：新规则追加在块尾，既有条目一字不动', () => {
  const r = upsertRuleBlock(RULE_A, RULE_B)
  assert.equal(r.action, 'added')
  assert.ok(r.inner.startsWith(RULE_A), '既有规则必须在最前且原样')
  assert.ok(r.inner.endsWith(RULE_B))
  assert.equal(r.inner, RULE_A + '\n' + RULE_B)
})

test('upsertRuleBlock：同规则幂等（归一化后包含 ⇒ exists，一字不写）', () => {
  const existing = RULE_A + '\n' + RULE_B
  const r = upsertRuleBlock(existing, '  ' + RULE_B.replace(/\s+/g, '  ') + '  ')
  assert.equal(r.action, 'exists')
  assert.equal(r.inner, existing, '既有文本必须逐字节不变')
  // 空 draft 也是 exists（不写空条目）
  assert.equal(upsertRuleBlock(existing, '   ').action, 'exists')
  // 首次布线：空块 + 规则 ⇒ added
  const fresh = upsertRuleBlock('', RULE_A)
  assert.equal(fresh.action, 'added')
  assert.equal(fresh.inner, RULE_A)
})

test('extractBlockInner / spliceBlock：块外内容一字不动', () => {
  const full = fileWith(RULE_A)
  assert.equal(extractBlockInner(full), RULE_A)
  const next = spliceBlock(full, RULE_A + '\n' + RULE_B)
  assert.ok(next.includes('# 文档正文'))
  assert.ok(next.includes('<!-- 块后注释 -->'))
  assert.ok(next.includes(RULE_A))
  assert.ok(next.includes(RULE_B))
  // marker 必须仍然成对且只有一个块
  assert.equal(next.split(MARKER_START).length, 2)
  assert.equal(next.split(MARKER_END).length, 2)
  // 无块的文件 ⇒ 追加到尾部
  const appended = spliceBlock('# 只有正文\n', RULE_A)
  assert.ok(appended.includes(MARKER_START) && appended.includes(RULE_A))
  assert.equal(extractBlockInner(appended), RULE_A)
})

test('checkBudget：超预算 must 拒（allowed=false 且回报字节与余量）', () => {
  const ok = checkBudget('abc', 65536)
  assert.equal(ok.allowed, true)
  assert.equal(ok.bytes, 3)
  assert.equal(ok.headroom, 65533)
  const over = checkBudget('x'.repeat(70000), 65000)
  assert.equal(over.allowed, false)
  assert.ok(over.headroom < 0)
  // 中文按 UTF-8 计字节（不是字符数）
  assert.equal(checkBudget('中', 3).bytes, 3)
})

test('事故复刻：连续两次布线后，块内必须同时含两条规则（旧实现会丢第一条）', () => {
  // 第一次 confirm 的产物
  let full = fileWith(RULE_A)
  // 第二次 confirm（新规则 B）——旧实现此处整体替换 ⇒ RULE_A 消失
  const up1 = upsertRuleBlock(extractBlockInner(full), RULE_B)
  assert.equal(up1.action, 'added')
  full = spliceBlock(full, up1.inner)
  assert.ok(full.includes(RULE_A), '第一条规则必须还在（这是旧实现丢的那条）')
  assert.ok(full.includes(RULE_B))
  // 第三次：重复写 B ⇒ 幂等，整文件逐字节不变
  const up2 = upsertRuleBlock(extractBlockInner(full), RULE_B)
  assert.equal(up2.action, 'exists')
  assert.equal(spliceBlock(full, up2.inner), full)
  // 再写 C ⇒ 三条并存且顺序稳定（A、B、C）
  const up3 = upsertRuleBlock(extractBlockInner(full), '**规则 C**：第三条。')
  const final = spliceBlock(full, up3.inner)
  const inner = extractBlockInner(final)
  assert.ok(inner.indexOf(RULE_A) < inner.indexOf(RULE_B))
  assert.ok(inner.indexOf(RULE_B) < inner.indexOf('**规则 C**'))
})
