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
