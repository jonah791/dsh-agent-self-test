/**
 * 收敛治理 · 重开簇检测 离线单测（2026-09-20，进化方向第二层）
 *
 * 核心判据：同族终态假设 ≥3 条时，必须在**新建前**提示收敛（refine / 承认不可测 / 转机制），
 * 而**不阻断**（§2.4 决定权归主体）。治的是「同题反复重开」，不是「被证伪」。
 *
 * 运行：先 npm run build（tsc），再 node --test tests/cluster.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { detectCluster, CLUSTER_THRESHOLD } from '../lib/cluster.js'

const H = (id, status, kind) => ({ id, status, probe: { kind } })

describe('detectCluster · 同族重开簇检测', () => {
  test('空库 ⇒ 无可收敛（不制造噪音）', () => {
    const r = detectCluster([], 'plan-before-action')
    assert.equal(r.total, 0)
    assert.equal(r.needsConvergence, false)
    assert.equal(r.text, '')
  })

  test('未达阈值（2 条终态）⇒ 不提示（阈值 3）', () => {
    const r = detectCluster([H('a', 'refuted', 'plan-before-action'), H('b', 'refuted', 'plan-before-action')], 'plan-before-action')
    assert.equal(r.terminal, 2)
    assert.equal(r.needsConvergence, false)
    assert.equal(r.text, '')
  })

  test('达阈值（3 条终态）⇒ 提示，且含三选一与「不阻断」', () => {
    const r = detectCluster([
      H('a', 'refuted', 'plan-before-action'),
      H('b', 'refuted', 'plan-before-action'),
      H('c', 'confirmed', 'plan-before-action'),
    ], 'plan-before-action')
    assert.equal(r.terminal, 3)
    assert.equal(r.needsConvergence, true)
    assert.match(r.text, /收敛提示/)
    assert.match(r.text, /refine 旧判据/)
    assert.match(r.text, /不可测/)
    assert.match(r.text, /转机制承载/)
    assert.match(r.text, /不阻断/)
  })

  test('只算同族：别的探针族再多也不触发', () => {
    const r = detectCluster([
      H('a', 'refuted', 'plan-before-action'),
      H('b', 'refuted', 'plan-before-action'),
      H('c', 'refuted', 'plan-before-action'),
    ], 'read-repeat')
    assert.equal(r.total, 0)
    assert.equal(r.needsConvergence, false)
  })

  test('活跃条目不计入终态判据，但如实报数', () => {
    const r = detectCluster([
      H('a', 'refuted', 'probe-before-action'),
      H('b', 'refuted', 'probe-before-action'),
      H('c', 'refuted', 'probe-before-action'),
      H('d', 'active', 'probe-before-action'),
      H('e', 'finding', 'probe-before-action'),
    ], 'probe-before-action')
    assert.equal(r.terminal, 3)
    assert.equal(r.active, 2)
    assert.equal(r.total, 5)
    assert.equal(r.needsConvergence, true)
    assert.match(r.text, /另有 2 条活跃/)
  })

  test('newestId 指认最后一条（「上一次重开」的锚点）', () => {
    const r = detectCluster([
      H('a', 'refuted', 'plan-before-action'),
      H('b', 'refuted', 'plan-before-action'),
      H('c', 'refuted', 'plan-before-action'),
    ], 'plan-before-action')
    assert.equal(r.newestId, 'c')
    assert.match(r.text, /最近一条 c/)
  })

  test('阈值可调（缺省 3）', () => {
    const hs = [H('a', 'refuted', 'plan-before-action'), H('b', 'refuted', 'plan-before-action')]
    assert.equal(detectCluster(hs, 'plan-before-action', 5).needsConvergence, false)
    assert.equal(detectCluster(hs, 'plan-before-action', 2).needsConvergence, true)
    assert.equal(CLUSTER_THRESHOLD, 3)
  })

  test('尸体测试·plan-before-action 血脉（7 条全终态）⇒ 必须提示，且「第 8 条」的数算对', () => {
    const lineage = [
      H('h-mtfg7bmy-1', 'refuted', 'plan-before-action'),
      H('h-mtfgltcj-2', 'refuted', 'plan-before-action'),
      H('h-mtfj0qnc-1', 'refuted', 'plan-before-action'),
      H('h-mtyenyo9-1', 'refuted', 'plan-before-action'),
      H('h-mu1atc6v-1', 'refuted', 'plan-before-action'),
      H('h-mu2w71yv-1', 'refuted', 'plan-before-action'),
      H('h-mu4judte-1', 'refuted', 'plan-before-action'),
    ]
    const r = detectCluster(lineage, 'plan-before-action')
    assert.equal(r.total, 7)
    assert.equal(r.terminal, 7)
    assert.equal(r.refuted, 7)
    assert.equal(r.needsConvergence, true)
    assert.match(r.text, /第 8 条/, '新建前提示 ⇒ 说的是「即将成为第 8 条」')
    assert.match(r.text, /最近一条 h-mu4judte-1/)
  })

  test('缺 probe 的条目不算任何族（不误伤）', () => {
    const r = detectCluster([{ id: 'x', status: 'refuted' }], 'plan-before-action')
    assert.equal(r.total, 0)
    assert.equal(r.needsConvergence, false)
  })
})
