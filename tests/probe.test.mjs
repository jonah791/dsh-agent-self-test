/**
 * probe-before-action 纯状态机离线单测（5.9 传感器——尸体测试纪律：坏样本必测触发，好样本必测不触发）
 * 运行：先 npm run build（tsc），再 node --test tests/probe.test.mjs
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createProbeFirstTracker, classifyTool, classifyShell, PROBEFIRST_DEFAULTS } from '../lib/probe.js'

const MIN = 60_000

describe('classifyTool · 工具角色分类', () => {
  test('探测集命中 probe', () => {
    assert.equal(classifyTool('web_search'), 'probe')
    assert.equal(classifyTool('comfy_status'), 'probe')
    assert.equal(classifyTool('preflight_check'), 'probe')
    assert.equal(classifyTool('recall'), 'probe')
  })
  test('实施集命中 mutating', () => {
    assert.equal(classifyTool('write'), 'mutating')
    assert.equal(classifyTool('edit'), 'mutating')
    assert.equal(classifyTool('plugin_mount'), 'mutating')
    assert.equal(classifyTool('daemon_restart'), 'mutating')
  })
  test('关键裁决：read/glob/grep 不算探测（否则 fs-policy 强制先读 → 传感器失灵）', () => {
    assert.equal(classifyTool('read'), 'neutral')
    assert.equal(classifyTool('glob'), 'neutral')
    assert.equal(classifyTool('grep'), 'neutral')
  })
  test('未知工具 neutral', () => {
    assert.equal(classifyTool('telegram_send'), 'neutral')
    assert.equal(classifyTool('todo_write'), 'neutral')
  })
  test('shell 启发式：只读动词=probe / 写动词=mutating / 其余 neutral', () => {
    assert.equal(classifyTool('wsl', { command: 'ls -la' }), 'probe')
    assert.equal(classifyTool('pwsh', { command: 'Get-Process | Select-Object Name' }), 'probe')
    assert.equal(classifyTool('pwsh', { command: 'Set-Content x.txt hi' }), 'mutating')
    assert.equal(classifyTool('wsl', { command: 'rm -rf /tmp/x' }), 'mutating')
    assert.equal(classifyTool('wsl', { command: 'echo hello' }), 'probe')
    assert.equal(classifyTool('pwsh', { command: 'npm test' }), 'neutral')
    assert.equal(classifyTool('pwsh'), 'neutral')            // 无 args
    assert.equal(classifyShell('python --version'), 'probe')
  })
})

describe('createProbeFirstTracker · 行动前探测状态机', () => {
  test('尸体样本（已知坏）：无探测直接实施突发 + 撞墙 → 触发证据', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    let ev = t.feed('read', false, undefined, t0)                    // neutral（read 不算探测）
    ev = t.feed('write', true, undefined, t0 + 10_000)              // mutating 1 + fail
    assert.equal(ev, null, 'actions=1 未达标')
    ev = t.feed('edit', false, { file_path: 'x' }, t0 + 20_000)     // mutating 2
    assert.equal(ev, null, 'actions=2 未达标')
    ev = t.feed('plugin_mount', false, undefined, t0 + 30_000)      // mutating 3 → 达标+failures≥1 → 触发
    assert.ok(ev !== null, '第 3 个 mutating 应触发证据')
    assert.equal(ev.actions, 3)
    assert.equal(ev.failures, 1)
    assert.equal(ev.hadProbeBefore, false)
    assert.equal(ev.probeWindowMs, PROBEFIRST_DEFAULTS.probeWindowMs)
  })

  test('合规样本（已知好）：行动前做过证伪探测 → 不触发', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    t.feed('web_search', false, undefined, t0)                       // 探测信号
    t.feed('write', true, undefined, t0 + 10_000)
    t.feed('edit', false, undefined, t0 + 20_000)
    const ev = t.feed('plugin_mount', false, undefined, t0 + 30_000)
    assert.equal(ev, null, 'hadProbeBefore=true 不应触发')
  })

  test('探测太旧（超出回看窗口）→ 视同无探测，触发', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    const staleProbe = t0 - 16 * MIN                                 // 16 分钟前（默认窗口 15min）
    t.feed('comfy_status', false, undefined, staleProbe)
    t.feed('comfy_run', true, undefined, t0)
    t.feed('comfy_submit', false, undefined, t0 + 10_000)
    const ev = t.feed('write', false, undefined, t0 + 20_000)
    assert.ok(ev !== null, '探测超出窗口应判无探测')
    assert.equal(ev.lastProbeAgeMs !== null, true)
  })

  test('无失败（盲动但走运）→ 不触发（5.9 采证对应「假设被推翻=撞墙」，幸运不记）', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    t.feed('write', false, undefined, t0)
    t.feed('edit', false, undefined, t0 + 10_000)
    const ev = t.feed('edit', false, undefined, t0 + 20_000)
    assert.equal(ev, null)
  })

  test('每突发最多一条证据（evidenced 防重复）', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    t.feed('write', true, undefined, t0)
    t.feed('edit', false, undefined, t0 + 10_000)
    const ev1 = t.feed('edit', false, undefined, t0 + 20_000)
    assert.ok(ev1 !== null)
    const ev2 = t.feed('edit', true, undefined, t0 + 30_000)         // 同突发继续
    assert.equal(ev2, null, '已记过证据不应重复')
  })

  test('gap 断开新突发：旧突发在 3 个 mutating 后于新调用点结算', () => {
    const t = createProbeFirstTracker()
    const t0 = 1_000_000_000
    // 突发1：3 mutating，失败发生在第 4 个调用（仍在 gap 内则即时触发；这里刻意让第 3 个后隔 gap 才失败）
    t.feed('write', false, undefined, t0)
    t.feed('edit', false, undefined, t0 + 10_000)
    t.feed('edit', false, undefined, t0 + 20_000)
    // 无失败 → 未触发；下一调用超 gap → 新突发起点，旧突发结算（仍无 fail，不触发）
    const ev = t.feed('write', true, undefined, t0 + 100_000)
    assert.equal(ev, null, '旧突发无失败不应触发')
  })
})
