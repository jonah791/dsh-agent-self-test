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
  test('能力索引路径的 read/glob 计为探测（白名单，任务 t-a3a047a1）——且不退化成恒真', () => {
    // 命中：仪器索引 / 自研插件目录 / 技能目录
    assert.equal(classifyTool('read', { file_path: 'E:\\alice\\TOOLS.md' }), 'probe')
    assert.equal(classifyTool('read', { file_path: '/mnt/e/alice/projects/self/TOOLS.md' }), 'probe')
    assert.equal(classifyTool('glob', { pattern: '**/*.ts', path: 'E:\\alice\\self-plugins' }), 'probe')
    assert.equal(classifyTool('read', { file_path: '/mnt/c/Users/tr/.agents/skills/x/SKILL.md' }), 'probe')
    // 不命中：普通脚本 / 产物目录 / 相似但不同的文件名 / 无路径
    assert.equal(classifyTool('read', { file_path: 'E:\\alice\\_tmp_scripts\\rehost.sh' }), 'neutral')
    assert.equal(classifyTool('glob', { pattern: '*.md', path: 'E:\\alice\\_tmp_review' }), 'neutral')
    assert.equal(classifyTool('read', { file_path: 'E:\\alice\\TOOLS.md.bak' }), 'neutral')
    assert.equal(classifyTool('read'), 'neutral')
    assert.equal(classifyTool('glob', {}), 'neutral')
    // 白名单只对 read/glob 生效：别的工具带这个路径也不因此变 probe
    assert.equal(classifyTool('telegram_send', { file_path: 'E:\\alice\\TOOLS.md' }), 'neutral')
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

  test('白名单尸体测试：读普通文件不算探测 → 违规仍必须触发（防退化成恒真）', () => {
    const t = createProbeFirstTracker()
    const t0 = 4_000_000_000
    t.feed('read', false, { file_path: 'E:/alice/src/x.ts' }, t0)
    t.feed('write', true, undefined, t0 + 10_000)
    t.feed('edit', false, { file_path: 'x' }, t0 + 20_000)
    const ev = t.feed('plugin_mount', false, undefined, t0 + 30_000)
    assert.ok(ev !== null, '读普通文件不得被当作探测 ⇒ 违规证据仍应产出')
    assert.equal(ev.hadProbeBefore, false)
  })

  test('白名单好样本：先读 TOOLS.md 能力索引 → 实施突发不产违规', () => {
    const t = createProbeFirstTracker()
    const t0 = 5_000_000_000
    t.feed('read', false, { file_path: 'E:/alice/TOOLS.md' }, t0)
    t.feed('write', true, undefined, t0 + 10_000)
    t.feed('edit', false, undefined, t0 + 20_000)
    const ev = t.feed('plugin_mount', false, undefined, t0 + 30_000)
    assert.equal(ev, null, '读了能力索引 = 行动前有探测 ⇒ 不应产违规证据')
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

// ── survived 路径（2026-09-17，t-b2c2d903）：合规行为也要能被记一笔 ──
// ⚠ 证据在**第 3 个 mutating 调用当场**发射（tryEmit 在每次 feed 末尾跑，不等到下个突发）——
//   照既有测试（白名单尸体/好样本）的模式在那一调上断言。
const T0 = 1_700_000_000_000

test('probe-before-action：行动前探测过 + 实施 + 无失败 ⇒ survived', () => {
  const t = createProbeFirstTracker()
  t.feed('web_search', false, {}, T0)                                  // 探测（外部世界）
  t.feed('write', false, {}, T0 + 1_000)                               // 首个 mutating：窗口内有探测 ⇒ 冻结为 true
  t.feed('edit', false, {}, T0 + 2_000)                                // actions=2
  const ev = t.feed('plugin_mount', false, {}, T0 + 3_000)             // actions=3 ⇒ 实时结算
  assert.equal(ev?.verdict, 'survived')
  assert.equal(ev?.hadProbeBefore, true)
  assert.equal(ev?.actions, 3)
})

test('probe-before-action：零探测 + 实施 + 撞墙 ⇒ violation（回归，口径不变）', () => {
  const t = createProbeFirstTracker()
  t.feed('write', false, {}, T0 + 100_000)
  t.feed('edit', false, {}, T0 + 101_000)
  const ev = t.feed('plugin_mount', true, {}, T0 + 102_000)
  assert.equal(ev?.verdict, 'violated')
  assert.equal(ev?.hadProbeBefore, false)
})

test('probe-before-action：零探测 + 实施 + 没撞墙 ⇒ 不产证据（不合规但未证伪）', () => {
  const t = createProbeFirstTracker()
  t.feed('write', false, {}, T0 + 200_000)
  t.feed('edit', false, {}, T0 + 201_000)
  const ev = t.feed('plugin_mount', false, {}, T0 + 202_000)
  assert.equal(ev, null)
})

test('probe-before-action：探测过但撞墙 ⇒ 既非违规也非 survived（诚实留白）', () => {
  const t = createProbeFirstTracker()
  t.feed('recall', false, {}, T0 + 300_000)
  t.feed('write', false, {}, T0 + 301_000)
  t.feed('edit', false, {}, T0 + 302_000)
  const ev = t.feed('plugin_mount', true, {}, T0 + 303_000)
  assert.equal(ev, null, '探测过 ⇒ 不算违规；撞墙 ⇒ 不算经受住检验')
})
