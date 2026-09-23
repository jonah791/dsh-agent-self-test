/**
 * 探针极性 · 方向判定 离线单测（任务 t-56b052fb）
 *
 * 本套的核心是**尸体测试**：复刻真实被误判的假设形状（正向前景主张 + 违规证据），
 * 断言方向判为 refute —— 修复前这套判定根本不存在，消费方一律把 finding 读成「可 confirm」。
 *
 * 运行：先 npm run build（tsc），再 node --test tests/polarity.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  readEventVerdict,
  resolvePolarity,
  computeDirection,
  contradictsDirection,
  DEFAULT_POLARITY,
  LEGACY_UNLABELED_VERDICT,
} from '../lib/polarity.js'
import { createBurstTracker } from '../lib/burst.js'
import { createProbeFirstTracker } from '../lib/probe.js'

describe('readEventVerdict · 方向字段读取（canonical + 旧名兼容）', () => {
  test('canonical：detail.verdict 两种值', () => {
    assert.equal(readEventVerdict({ verdict: 'violated' }), 'violated')
    assert.equal(readEventVerdict({ verdict: 'survived' }), 'survived')
  })
  test('兼容旧字段：probe-before-action 曾用 detail.kind（词形 violation ≠ violated）', () => {
    assert.equal(readEventVerdict({ kind: 'violation' }), 'violated')
    assert.equal(readEventVerdict({ kind: 'violated' }), 'violated')
    assert.equal(readEventVerdict({ kind: 'survived' }), 'survived')
  })
  test('无标签 / 非对象 / 未知值 ⇒ null（诚实留白，不猜方向）', () => {
    assert.equal(readEventVerdict({ path: 'x', readsInWindow: 3 }), null)
    assert.equal(readEventVerdict(undefined), null)
    assert.equal(readEventVerdict(null), null)
    assert.equal(readEventVerdict('violated'), null)
    assert.equal(readEventVerdict({ verdict: 'ok' }), null)
    assert.equal(readEventVerdict({ kind: 'probe' }), null)
  })
  test('verdict 优先于旧 kind（两名并存时不歧义）', () => {
    assert.equal(readEventVerdict({ verdict: 'survived', kind: 'violation' }), 'survived')
  })
})

describe('resolvePolarity · 极性解析（显式声明优先，否则按探针取默认）', () => {
  test('显式声明优先于默认', () => {
    assert.equal(resolvePolarity({ kind: 'probe-before-action', polarity: 'violation-supports' }), 'violation-supports')
    assert.equal(resolvePolarity({ kind: 'read-repeat', polarity: 'violation-refutes' }), 'violation-refutes')
  })
  test('默认：四族 violation-refutes，read-repeat violation-supports（自省缺陷型主张）', () => {
    assert.equal(resolvePolarity({ kind: 'tool-failure-rate' }), 'violation-refutes')
    assert.equal(resolvePolarity({ kind: 'claim-vs-evidence' }), 'violation-refutes')
    assert.equal(resolvePolarity({ kind: 'plan-before-action' }), 'violation-refutes')
    assert.equal(resolvePolarity({ kind: 'probe-before-action' }), 'violation-refutes')
    assert.equal(resolvePolarity({ kind: 'read-repeat' }), 'violation-supports')
  })
  test('无探针 / 未知 kind ⇒ 保守回退 violation-refutes（不含混声明极性）', () => {
    assert.equal(resolvePolarity(undefined), 'violation-refutes')
    assert.equal(resolvePolarity({ kind: 'no-such-kind' }), 'violation-refutes')
  })
  test('默认表覆盖全部五族（防新增探针漏配）', () => {
    assert.equal(Object.keys(DEFAULT_POLARITY).length, 5)
    assert.equal(Object.keys(LEGACY_UNLABELED_VERDICT).length, 5)
  })
})

describe('computeDirection · 方向判定', () => {
  const E = (verdict) => [{ detail: verdict === undefined ? {} : { verdict } }]

  test('全 violated + violation-refutes ⇒ refute（建议证伪）', () => {
    const r = computeDirection([...E('violated'), ...E('violated'), ...E('violated')], { kind: 'probe-before-action' })
    assert.equal(r.direction, 'refute')
    assert.equal(r.support, 0)
    assert.equal(r.refute, 3)
    assert.match(r.text, /建议 refute/)
    assert.match(r.text, /假设不成立/)
  })

  test('全 survived + violation-refutes ⇒ support（建议 confirm）', () => {
    const r = computeDirection([...E('survived'), ...E('survived')], { kind: 'tool-failure-rate' })
    assert.equal(r.direction, 'support')
    assert.equal(r.support, 2)
    assert.match(r.text, /建议 confirm/)
  })

  test('同一份 violated 证据，极性翻转 ⇒ 方向翻转（read-repeat 语义）', () => {
    const evs = [...E('violated'), ...E('violated')]
    assert.equal(computeDirection(evs, { kind: 'read-repeat' }).direction, 'support')
    assert.equal(computeDirection(evs, { kind: 'read-repeat', polarity: 'violation-refutes' }).direction, 'refute')
  })

  test('方向混杂 ⇒ mixed（建议 refine，不诱导单向裁决）', () => {
    const r = computeDirection([...E('violated'), ...E('survived')], { kind: 'tool-failure-rate' })
    assert.equal(r.direction, 'mixed')
    assert.match(r.text, /建议 refine/)
  })

  test('空证据 ⇒ unknown（不含混判向）', () => {
    const r = computeDirection([], { kind: 'tool-failure-rate' })
    assert.equal(r.direction, 'unknown')
    assert.equal(r.support + r.refute, 0)
    assert.match(r.text, /无法判向/)
  })

  test('历史证据推定：只对原本「只有违规路径」的三族生效，条数如实记账', () => {
    const legacyProbe = computeDirection([{}, {}, {}], { kind: 'probe-before-action' })
    assert.equal(legacyProbe.legacyAssumed, 3)
    assert.equal(legacyProbe.direction, 'refute')
    assert.match(legacyProbe.text, /按历史规则推定/)

    const legacyRepeat = computeDirection([{}, {}], { kind: 'read-repeat' })
    assert.equal(legacyRepeat.legacyAssumed, 2)
    assert.equal(legacyRepeat.direction, 'support', '自省缺陷型主张：重复读事件支持它')
  })

  test('推定不外溢：另有 direction 字段的两族无标签证据一律 unknown（不猜）', () => {
    const r1 = computeDirection([{}, {}], { kind: 'tool-failure-rate' })
    assert.equal(r1.legacyAssumed, 0)
    assert.equal(r1.unknown, 2)
    assert.equal(r1.direction, 'unknown')

    const r2 = computeDirection([{}], { kind: 'claim-vs-evidence' })
    assert.equal(r2.legacyAssumed, 0)
    assert.equal(r2.direction, 'unknown')
  })

  // ── 尸体测试：复刻真实被误判的 4 条假设形状（2026-09-17 取证）──
  test('尸体测试·h-mtisdxq1-1 形（「我会先做探测」+ 3 条旧违规证据）⇒ 必须是 refute，不是 confirm', () => {
    // 旧数据形状：probe-before-action 只发违规事件，detail 无 verdict 字段（当时字段名是 kind:'violation'）
    const evidence = [{ detail: { burstStartTs: 'x', calls: 4, actions: 3, failures: 1, kind: 'violation' } }]
    const r = computeDirection(evidence, { kind: 'probe-before-action' })
    assert.equal(r.direction, 'refute', '违规证据不能读成「假设成立」')
    assert.equal(contradictsDirection('confirm', r.direction), true, 'confirm 与方向相悖 ⇒ 必须报警')
    assert.equal(contradictsDirection('refute', r.direction), false)
  })

  test('尸体测试·昨夜新增的 survived 路径（canonical verdict）⇒ support，可 confirm', () => {
    const r = computeDirection(
      [{ detail: { verdict: 'survived', actions: 3, failures: 0 } }, { detail: { verdict: 'survived' } }],
      { kind: 'probe-before-action' },
    )
    assert.equal(r.direction, 'support')
    assert.equal(contradictsDirection('confirm', r.direction), false)
    assert.equal(contradictsDirection('refute', r.direction), true, '淘汰一条有支持证据的假设也要提醒')
  })
})

describe('contradictsDirection · 裁决护栏判据', () => {
  test('unknown 不报警（没有方向信息时不得干扰裁决）', () => {
    assert.equal(contradictsDirection('confirm', 'unknown'), false)
    assert.equal(contradictsDirection('refute', 'unknown'), false)
  })
  test('mixed 对任何单向裁决都报警', () => {
    assert.equal(contradictsDirection('confirm', 'mixed'), true)
    assert.equal(contradictsDirection('refute', 'mixed'), true)
  })
  test('同向不报警', () => {
    assert.equal(contradictsDirection('confirm', 'support'), false)
    assert.equal(contradictsDirection('refute', 'refute'), false)
  })
})

describe('载荷契约 · 五族探针的证据都必须带 canonical verdict 字段', () => {
  test('plan-before-action：突发无规划 + 有失败 ⇒ verdict=violated', () => {
    const t = createBurstTracker()
    const T = 1_700_000_000_000
    let ev = null
    for (let i = 0; i < 5; i += 1) ev = t.feed('read', i === 4, T + i * 1_000)
    assert.equal(ev?.verdict, 'violated', '旧实现在此返回的 detail 无任何方向字段')
    assert.equal(readEventVerdict(ev), 'violated')
  })

  test('probe-before-action：违规方向用 violated 词形（与 failure-rate 词表一致）', () => {
    const t = createProbeFirstTracker()
    const T = 1_700_000_100_000
    t.feed('write', false, {}, T)
    t.feed('edit', false, {}, T + 1_000)
    const ev = t.feed('plugin_mount', true, {}, T + 2_000)
    assert.equal(ev?.verdict, 'violated')
    assert.equal(readEventVerdict(ev), 'violated')
  })
})

describe('倾向度分档 · lean/ratio（2026-09-20 增量：让 7:1 不再与 1:1 同级）', () => {
  const E = (verdict) => [{ detail: { verdict } }]
  const mix = (yes, no) => [
    ...Array.from({ length: yes }, () => ({ detail: { verdict: 'survived' } })),
    ...Array.from({ length: no }, () => ({ detail: { verdict: 'violated' } })),
  ]

  test('7:1 ⇒ mixed 但 lean-support（近成立，差的是反例而非判据）', () => {
    const r = computeDirection(mix(7, 1), { kind: 'tool-failure-rate' })
    assert.equal(r.direction, 'mixed')
    assert.equal(r.lean, 'lean-support')
    assert.equal(r.ratio, 0.875)
    assert.match(r.text, /倾向支持 7:1/)
  })

  test('1:1 ⇒ mixed 且 balanced（真判不了 —— 与 7:1 不再同级）', () => {
    const r = computeDirection(mix(1, 1), { kind: 'tool-failure-rate' })
    assert.equal(r.direction, 'mixed')
    assert.equal(r.lean, 'balanced')
    assert.equal(r.ratio, 0.5)
  })

  test('1:7 ⇒ lean-refute', () => {
    const r = computeDirection(mix(1, 7), { kind: 'tool-failure-rate' })
    assert.equal(r.lean, 'lean-refute')
    assert.equal(r.ratio, 0.125)
  })

  test('阈值边界：4:1（ratio 0.8）⇒ lean-support；1:4（0.2）⇒ lean-refute', () => {
    assert.equal(computeDirection(mix(4, 1), { kind: 'tool-failure-rate' }).lean, 'lean-support')
    assert.equal(computeDirection(mix(1, 4), { kind: 'tool-failure-rate' }).lean, 'lean-refute')
  })

  test('无方向证据 ⇒ lean=none / ratio=0（诚实留白，不当成 balanced）', () => {
    const r = computeDirection([], { kind: 'tool-failure-rate' })
    assert.equal(r.lean, 'none')
    assert.equal(r.ratio, 0)
  })

  test('纯单向 ⇒ lean 与 direction 同向', () => {
    assert.equal(computeDirection(mix(3, 0), { kind: 'tool-failure-rate' }).lean, 'lean-support')
    assert.equal(computeDirection(mix(0, 3), { kind: 'tool-failure-rate' }).lean, 'lean-refute')
  })

  test('护栏：lean-support 时 confirm 放行 / refute 报警（旧行为对两者都报警）', () => {
    assert.equal(contradictsDirection('confirm', 'mixed', 'lean-support'), false)
    assert.equal(contradictsDirection('refute', 'mixed', 'lean-support'), true)
  })

  test('护栏：lean-refute 时 refute 放行 / confirm 报警', () => {
    assert.equal(contradictsDirection('refute', 'mixed', 'lean-refute'), false)
    assert.equal(contradictsDirection('confirm', 'mixed', 'lean-refute'), true)
  })

  test('护栏：balanced 仍对任何单向裁决报警（真混杂不放水）', () => {
    assert.equal(contradictsDirection('confirm', 'mixed', 'balanced'), true)
    assert.equal(contradictsDirection('refute', 'mixed', 'balanced'), true)
  })

  test('向后兼容：不传 lean ⇒ 行为与旧版完全一致（mixed 一律报警）', () => {
    assert.equal(contradictsDirection('confirm', 'mixed'), true)
    assert.equal(contradictsDirection('refute', 'mixed'), true)
  })

  test('尸体测试·h-mu4djfqf-1 形（7 支持 / 1 反对的 confirmed）⇒ 不再被误报为「方向相悖」', () => {
    const r = computeDirection(mix(7, 1), { kind: 'probe-before-action', polarity: 'violation-refutes' })
    // 旧口径：mixed + confirmed ⇒ ⚠极性存疑（把「分辨率不足」误诊成「方向读反」）
    assert.equal(r.lean, 'lean-support')
    assert.equal(contradictsDirection('confirm', r.direction, r.lean), false, '倾向支持时 confirm 不该报警')
  })

  test('尸体测试·真混杂（3:2 · 本次两条 finding 的形状）⇒ balanced，仍该 refine 不放行', () => {
    const r = computeDirection(mix(3, 2), { kind: 'probe-before-action' })
    assert.equal(r.lean, 'balanced')
    assert.equal(contradictsDirection('confirm', r.direction, r.lean), true, '真混杂时必须继续报警')
  })
})
