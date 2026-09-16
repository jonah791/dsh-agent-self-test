/**
 * burst 纯状态机离线单测（plan-before-action 探针核心逻辑）
 * 运行：先 build（tsc）再 node --test tests/burst.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createBurstTracker, BURST_DEFAULTS } from '../lib/burst.js'

describe('createBurstTracker · 突发检测', () => {
  test('无规划 + 连续调用达标 + 含失败 → 触发证据', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    // 5 次连续调用（间隔 10s < 60s），无 todo_write，其中 1 次失败
    let ev = t.feed('read', false, t0)          // 1
    ev = t.feed('read', false, t0 + 10_000)     // 2
    ev = t.feed('read', false, t0 + 20_000)     // 3
    ev = t.feed('read', true, t0 + 30_000)      // 4（失败）
    ev = t.feed('read', false, t0 + 40_000)     // 5（达标）
    assert.ok(ev !== null, '第 5 次调用应触发证据')
    assert.equal(ev.calls, 5)
    assert.equal(ev.failures, 1)
    assert.equal(ev.hadPlan, false)
  })

  test('有规划（突发前 3 分钟内 todo_write）→ 不触发', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    t.feed('todo_write', false, t0)             // 规划信号
    let ev = t.feed('read', false, t0 + 10_000)
    ev = t.feed('read', false, t0 + 20_000)
    ev = t.feed('read', false, t0 + 30_000)
    ev = t.feed('read', true, t0 + 40_000)      // 失败
    ev = t.feed('read', false, t0 + 50_000)     // 5 次达标
    assert.equal(ev, null, '有规划时不应触发证据（hadPlan 判定为真）')
  })

  test('无失败（调用全成功）→ 不触发', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    let ev = t.feed('read', false, t0)
    ev = t.feed('read', false, t0 + 10_000)
    ev = t.feed('read', false, t0 + 20_000)
    ev = t.feed('read', false, t0 + 30_000)
    ev = t.feed('read', false, t0 + 40_000)     // 5 次但无失败
    assert.equal(ev, null)
  })

  test('间隔超 burstGapMs 为新突发；上一突发达标在边界判定', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    // 第一段：4 次含 1 失败（未达 minSteps=5，不触发）
    t.feed('read', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', true, t0 + 20_000)
    t.feed('read', false, t0 + 30_000)
    // 间隔 > 60s → 新突发；上一突发 calls=4 < 5，不触发
    const ev = t.feed('read', false, t0 + 200_000)
    assert.equal(ev, null, '上一突发未达 minSteps 不应触发')
  })

  test('上一突发达标在切换时触发（新突发起点判定旧突发）', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    // 第一段：5 次含 1 失败 → 第 5 次已触发
    t.feed('read', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', false, t0 + 20_000)
    t.feed('read', true, t0 + 30_000)
    let ev = t.feed('read', false, t0 + 40_000)
    assert.ok(ev !== null, '第 5 次即触发')
    // 切换到新突发：同一旧突发不再重复触发（evidenced）
    const ev2 = t.feed('read', false, t0 + 200_000)
    assert.equal(ev2, null, '同一突发不重复触发')
  })

  test('evidenced 只触发一次：同突发后续调用不重复', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    t.feed('read', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', true, t0 + 20_000)
    t.feed('read', false, t0 + 30_000)
    const ev1 = t.feed('read', false, t0 + 40_000)   // 第 5 次触发
    const ev2 = t.feed('read', false, t0 + 50_000)   // 同突发第 6 次
    assert.ok(ev1 !== null)
    assert.equal(ev2, null, '同突发只触发一次')
  })

  test('自定义 minSteps（如 3）按参数生效', () => {
    const t = createBurstTracker()
    const t0 = 1_000_000
    let ev = t.feed('read', false, t0, { minSteps: 3 })
    ev = t.feed('read', false, t0 + 10_000, { minSteps: 3 })
    ev = t.feed('read', true, t0 + 20_000, { minSteps: 3 })   // 3 次达标
    assert.ok(ev !== null, 'minSteps=3 时第 3 次触发')
    assert.equal(ev.calls, 3)
  })

  test('BURST_DEFAULTS 导出默认值', () => {
    assert.equal(BURST_DEFAULTS.burstGapMs, 60_000)
    assert.equal(BURST_DEFAULTS.minSteps, 5)
    assert.equal(BURST_DEFAULTS.planWindowMs, 180_000)
  })
})

// ── 双路径结算（2026-09-17，t-bede2fab）：对照组必须能采到证据 ──
// 旧实现只有违规路径 ⇒「有规划且顺利」永不产证据 ⇒「我会先规划」类主张结构上不可确认
// （实测 h-mtfgltcj-2 / h-mtfj0qnc-1 两条条件型假设因此被判 refute）。
describe('createBurstTracker · survived 路径（对照组）', () => {
  test('有规划 + 达标 + 零失败 ⇒ survived（旧实现在此返回 null）', () => {
    const t = createBurstTracker()
    const t0 = 2_000_000
    t.feed('todo_write', false, t0)              // 规划信号 ⇒ 自身即突发第 1 次调用，hadPlan=true
    t.feed('read', false, t0 + 10_000)           // 2
    t.feed('read', false, t0 + 20_000)           // 3
    t.feed('read', false, t0 + 30_000)           // 4
    const ev = t.feed('read', false, t0 + 40_000) // 5 ⇒ 实时结算
    assert.ok(ev !== null, '有规划且零失败必须产证据')
    assert.equal(ev.verdict, 'survived')
    assert.equal(ev.hadPlan, true, 'hadPlan 必须与 verdict 自洽（旧实现把它写死成 false）')
    assert.equal(ev.failures, 0)
    assert.equal(ev.calls, 5)
  })

  test('回归：无规划 + 达标 + 撞墙 ⇒ violated（口径不变）', () => {
    const t = createBurstTracker()
    const t0 = 2_100_000
    t.feed('read', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', true, t0 + 20_000)            // 撞墙
    t.feed('read', false, t0 + 30_000)
    const ev = t.feed('read', false, t0 + 40_000)
    assert.equal(ev?.verdict, 'violated')
    assert.equal(ev?.hadPlan, false)
    assert.equal(ev?.failures, 1)
  })

  test('诚实留白：无规划但零失败 ⇒ 不记（既不合规、也没撞墙 ⇒ 无判据）', () => {
    const t = createBurstTracker()
    const t0 = 2_200_000
    t.feed('read', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', false, t0 + 20_000)
    t.feed('read', false, t0 + 30_000)
    const ev = t.feed('read', false, t0 + 40_000)
    assert.equal(ev, null)
  })

  test('诚实留白：有规划但撞墙 ⇒ 不记（对照组里撞墙不能证伪「规划有价值」）', () => {
    const t = createBurstTracker()
    const t0 = 2_300_000
    t.feed('todo_write', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', false, t0 + 20_000)
    t.feed('read', true, t0 + 30_000)            // 撞墙
    t.feed('read', false, t0 + 40_000)           // 5 ⇒ 结算：hadPlan=true 且 failures=1 ⇒ 两条路径都不记
    assert.equal(t.feed('read', false, t0 + 50_000), null)
  })

  test('规划窗口外（> planWindowMs）的 todo_write 不算规划 ⇒ 走违规路径', () => {
    const t = createBurstTracker()
    const t0 = 2_400_000
    t.feed('todo_write', false, t0)              // 规划（t0）
    t.feed('read', false, t0 + 200_000)          // 200s > planWindowMs(180s) ⇒ 新突发且 hadPlan=false
    t.feed('read', false, t0 + 210_000)
    t.feed('read', true, t0 + 220_000)
    t.feed('read', false, t0 + 230_000)
    const ev = t.feed('read', false, t0 + 240_000)
    assert.equal(ev?.verdict, 'violated')
    assert.equal(ev?.hadPlan, false)
  })

  test('survived 也只记一次（evidenced 防重复，同突发）', () => {
    const t = createBurstTracker()
    const t0 = 2_500_000
    t.feed('todo_write', false, t0)
    t.feed('read', false, t0 + 10_000)
    t.feed('read', false, t0 + 20_000)
    t.feed('read', false, t0 + 30_000)
    const ev1 = t.feed('read', false, t0 + 40_000)  // 5 ⇒ survived
    const ev2 = t.feed('read', false, t0 + 50_000)  // 6 ⇒ 同突发不重复
    assert.equal(ev1?.verdict, 'survived')
    assert.equal(ev2, null)
  })
})
