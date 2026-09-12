/**
 * claim-evidence.test.mjs — claim-vs-evidence 探针的离线单测（跑 lib 产物）。
 *
 * 尸体样本取自 **2026-09-11~12 感知圈停摆事故的真实 life-log 行**（AGENTS.md 5.17）：
 * 该事故在四个既有探针眼里完全隐形（它们只看我的调用行为），本探针要能抓到它。
 * 运行：node tests/claim-evidence.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CLAIM_DEFAULTS,
  CLAIM_MARKER,
  EVIDENCE_MARKER,
  countLifeCycleClaims,
  decideClaimEvidence,
  parseLifeLogLine,
} from '../lib/claim-evidence.js'

const H = 60 * 60 * 1000
const NOW = Date.parse('2026-09-12T13:00:00.000Z')
const WIN = NOW - 6 * H

/** 造一行真实格式的 life-log 条目 */
const line = (atMs, kind, summary) => JSON.stringify({ at: new Date(atMs).toISOString(), kind, summary })

// ---- 尸体样本：真实停摆现场（09-12 修复前 6 小时窗口）----
test('尸体样本①：窗口内自述密集（跳过紧转轮）但零真实触发 → violated（假活）', () => {
  const lines = []
  // 真实现场：每 5 分钟一条「自我安排」，summary 含「本圈跳过」——自述在跑
  for (let i = 0; i < 12; i++) {
    lines.push(line(WIN + i * 30 * 60 * 1000, 'self-turn', '自我感知圈到期：主人消息已在队列（已被叫醒），本圈跳过'))
  }
  for (let i = 0; i < 12; i++) {
    lines.push(line(WIN + i * 30 * 60 * 1000 + 1000, 'status', '自我安排：180 分钟后自我感知圈（恒定周期）'))
  }
  const arrangedLine = line(WIN + 1000, 'status', '自我安排：180 分钟后自我感知圈（恒定周期）')
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(counts.arranged, 12)
  assert.equal(counts.triggered, 0)
  const ev = decideClaimEvidence(counts, {}, [arrangedLine])
  assert.ok(ev !== null)
  assert.equal(ev.verdict, 'violated', '29 小时零真实感知圈的指纹必须被判为假活')
  assert.match(ev.sample[0], new RegExp(CLAIM_MARKER))
})

test('好样本（健康日）：窗口内自述与实证并存 → survived', () => {
  // 09-10 实测 14 安排 / 8 触发
  const lines = []
  for (let i = 0; i < 6; i++) lines.push(line(WIN + i * 40 * 60 * 1000, 'status', '自我安排：180 分钟后自我感知圈（恒定周期到期）'))
  for (let i = 0; i < 4; i++) lines.push(line(WIN + i * 60 * 60 * 1000, 'self-turn', '自我感知圈触发：恒定感知周期到期（自我唤醒已发出）'))
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(counts.arranged, 6)
  assert.equal(counts.triggered, 4)
  const ev = decideClaimEvidence(counts)
  assert.ok(ev !== null)
  assert.equal(ev.verdict, 'survived')
})

test('静默样本：自述不足 minArranged → 不判定（静默属另一类失效，不误报）', () => {
  const lines = [line(WIN + H, 'status', '自我安排：30 分钟后自我感知圈')]
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(decideClaimEvidence(counts), null)
})

test('窗口边界：窗口外的条目不计入（否则历史健康期会掩盖当前停摆）', () => {
  const lines = [
    line(WIN - 60 * 1000, 'status', '自我安排：窗口前一分钟'),
    line(NOW + 60 * 1000, 'status', '自我安排：窗口后一分钟'),
    line(WIN + 1000, 'status', '自我安排：窗口内'),
  ]
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(counts.arranged, 1)
})

test('损坏行不得让探针整体失效（非法 JSON / 缺字段 / 空行）', () => {
  const lines = ['{ broken json', '', '{"at":"2026-09-12T12:00:00.000Z"}', line(WIN + 5000, 'status', '自我安排：x')]
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(counts.arranged, 1)
  assert.equal(parseLifeLogLine('{ broken json'), null)
  assert.equal(parseLifeLogLine(''), null)
})

test('实证标记独立生效：只有「自我感知圈触发」才算实证（普通 self-turn 不算）', () => {
  const lines = []
  for (let i = 0; i < 5; i++) lines.push(line(WIN + i * 10 * 60 * 1000, 'status', '自我安排：x'))
  // 「跳过」型 self-turn 是自述不是实证——这正是停摆日的伪装
  for (let i = 0; i < 20; i++) lines.push(line(WIN + i * 5 * 60 * 1000, 'self-turn', '自我感知圈到期：本圈跳过'))
  const counts = countLifeCycleClaims(lines, WIN, NOW)
  assert.equal(counts.triggered, 0, 'self-turn 条目不得被当作实证——停摆日正是靠它伪装成健康节律')
  assert.equal(decideClaimEvidence(counts)?.verdict, 'violated')
})

test('默认参数与标记常量稳定（被证据与文档引用，改动即破坏历史可比性）', () => {
  assert.equal(CLAIM_DEFAULTS.minArranged, 5)
  assert.equal(CLAIM_DEFAULTS.windowMs, 6 * H)
  assert.equal(CLAIM_MARKER, '自我安排')
  assert.equal(EVIDENCE_MARKER, '自我感知圈触发')
})
