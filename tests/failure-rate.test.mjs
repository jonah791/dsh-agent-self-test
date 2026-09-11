/**
 * tool-failure-rate 判定纯函数离线单测（2026-09-11 采证不对称修复）
 *
 * 运行：先 node <tsc> -p tsconfig.json --noCheck，再 node --test tests/failure-rate.test.mjs
 *
 * 尸体测试纪律（AGENTS.md 5.9 §2）：坏样本必测「会触发」，好样本必测「不触发」，
 * 并对新语义做防误报验证（否则「证实方向」会退化成噪声源）。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { decideFailureRateEvidence, FAILURERATE_DEFAULTS } from '../lib/failure-rate.js'

/** 构造「已含本次调用」的统计快照 */
function snap(calls, failures) {
  return { calls, failures }
}

describe('默认值', () => {
  test('threshold=0.3 / minSamples=20', () => {
    assert.equal(FAILURERATE_DEFAULTS.threshold, 0.3)
    assert.equal(FAILURERATE_DEFAULTS.minSamples, 20)
  })
})

describe('证伪方向：违规必记（保留旧行为）', () => {
  test('首次调用即失败 → rate=1.0 ≥ 0.3 → violated', () => {
    const ev = decideFailureRateEvidence('wq_simulate', snap(1, 1), true)
    assert.ok(ev !== null, '失败率超阈值必须记证据')
    assert.equal(ev.verdict, 'violated')
    assert.equal(ev.rate, 1)
  })

  test('滚动率跨过阈值时记 violated', () => {
    // 10 次 3 失败 = 0.3 → 正好达阈值（>= 判定）
    const ev = decideFailureRateEvidence('x', snap(10, 3), true)
    assert.equal(ev?.verdict, 'violated')
  })

  test('失败但率未达阈值 → 不记 violated', () => {
    // 20 次 2 失败 = 0.1 < 0.3
    const ev = decideFailureRateEvidence('x', snap(20, 2), true)
    assert.equal(ev?.verdict, 'survived', '20 是检查点且未越阈值 → 应走证实方向')
  })
})

describe('证实方向：经受住检验（本次修复的核心）', () => {
  test('尸体测试·修复前必失败的样本：零失败但达检查点 → survived', () => {
    // 旧实现在此处恒返回 null → 「X 可靠」类假设永远证据 0（本 bug 的现场）
    const ev = decideFailureRateEvidence('wq_simulate', snap(20, 0), false)
    assert.ok(ev !== null, '达检查点且未违规必须能采到证据——否则真值无法被证实')
    assert.equal(ev.verdict, 'survived')
    assert.equal(ev.calls, 20)
    assert.equal(ev.failures, 0)
    assert.equal(ev.rate, 0)
  })

  test('未达检查点 → 不记（防噪声刷屏）', () => {
    assert.equal(decideFailureRateEvidence('x', snap(19, 0), false), null)
    assert.equal(decideFailureRateEvidence('x', snap(1, 0), false), null)
  })

  test('只在检查点整数倍上报（20/40/60）', () => {
    assert.equal(decideFailureRateEvidence('x', snap(20, 0), false)?.verdict, 'survived')
    assert.equal(decideFailureRateEvidence('x', snap(21, 0), false), null)
    assert.equal(decideFailureRateEvidence('x', snap(40, 0), false)?.verdict, 'survived')
    assert.equal(decideFailureRateEvidence('x', snap(60, 0), false)?.verdict, 'survived')
  })

  test('低于阈值但有少量失败也算经受住（忠实于预测「率 < 阈值」）', () => {
    const ev = decideFailureRateEvidence('x', snap(40, 4), false) // 0.1 < 0.3
    assert.equal(ev?.verdict, 'survived')
    assert.equal(ev?.failures, 4)
  })

  test('检查点上失败率仍越阈值 → 不记 survived（避免与违规自相矛盾）', () => {
    // 20 次 8 失败 = 0.4 ≥ 0.3，且本次是成功调用 → 不采任何证据
    const ev = decideFailureRateEvidence('x', snap(20, 8), false)
    assert.equal(ev, null, '率越阈值时不得记「经受住」')
  })
})

describe('参数覆盖与边界', () => {
  test('minSamples 可覆盖：10 即上报', () => {
    assert.equal(decideFailureRateEvidence('x', snap(10, 0), false, { minSamples: 10 })?.verdict, 'survived')
  })

  test('threshold 可覆盖：0 表示零容忍（任何失败即 violated）', () => {
    const ev = decideFailureRateEvidence('x', snap(1, 1), true, { threshold: 0 })
    assert.equal(ev?.verdict, 'violated')
  })

  test('calls=0 不产证据（防御：未初始化快照）', () => {
    assert.equal(decideFailureRateEvidence('x', snap(0, 0), false), null)
  })

  test('证据携带 tool 名与阈值（供裁决定位）', () => {
    const ev = decideFailureRateEvidence('wq_simulate', snap(20, 0), false)
    assert.equal(ev?.tool, 'wq_simulate')
    assert.equal(ev?.threshold, 0.3)
    assert.equal(ev?.minSamples, 20)
  })
})
