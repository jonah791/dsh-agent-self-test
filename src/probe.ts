/**
 * probe-before-action 纯状态机（2026-09-01，AGENTS.md §5.9 配套传感器——任务板 t-b254b1a3）
 *
 * 观测「实施行动前是否先做最小证伪探测」（5.9 采证缺口的填补）：
 * - 行动突发 = 连续工具调用链（相邻间隔 < burstGapMs），其中 mutating 调用 ≥ minActions
 * - 探测信号 = 对外部目标的**实验/查证**调用（分类集 PROBE_TOOLS + shell 只读动词启发）
 * - 违规证据 = 突发首个 mutating 前回看 probeWindowMs 内**零探测** 且 突发内 ≥1 失败
 *   ——「没探测就冲 + 撞墙」才记，忠实对应 5.9 的可证伪预测（能力假设事后被推翻 = 撞墙）
 * - 每个突发最多记一次证据（evidenced 防重复）
 *
 * 关键裁决（为什么排除 read/glob/grep）：
 *   fs-observation-policy 强制写前先 read——若把本地读文件算作探测，
 *   「行动前有探测」近乎恒真，传感器失灵。5.9 的探测是「一次请求/一次注入/一次 head」
 *   的**证伪实验**，不是读材料。read 类一律归 neutral。
 *
 * 纯状态机：无 IO、无时间依赖（now 由调用方注入），便于离线单测（tests/probe.test.mjs）。
 */

export type ToolRole = 'probe' | 'mutating' | 'neutral'

/** 探测集：对外部目标的证伪实验/状态查证（精确名维护，宁缺勿滥——误入会漏报违规） */
export const PROBE_TOOLS: ReadonlySet<string> = new Set([
  // 检索/抓取（外部世界探测）
  'web_search', 'search_web', 'search_serp', 'search_github', 'search_site', 'search_code',
  'search_community', 'search_darkweb', 'search_share', 'search_patent', 'search_academic',
  'search_shodan', 'search_build_query', 'search_quota', 'search_cache',
  'fetch_page', 'fetch_robust', 'fetch_tor', 'archive_search', 'archive_restore',
  'lookup_whois', 'lookup_dns_history', 'enum_subdomains',
  // 侦察类（读性质，无持久副作用）
  'red_banner_grab', 'red_crawl_links', 'red_dir_brute', 'red_security_headers',
  'red_sensitive_paths', 'red_subdomain_enum', 'red_tech_fingerprint', 'red_cve_match',
  'blue_autoruns_check', 'blue_baseline_check', 'blue_cve_lookup', 'blue_event_log_query',
  'blue_hash_lookup', 'blue_ioc_query', 'blue_port_scan', 'blue_process_audit',
  'sec_nmap', 'sec_masscan', 'sec_subfinder', 'sec_whatweb', 'sec_dnsrecon', 'sec_gobuster', 'sec_nikto',
  'otw_request', 'otw_ssh', 'otw_blind',
  // ComfyUI 查询面（生图体系探测）
  'comfy_status', 'comfy_task', 'comfy_queue', 'comfy_models', 'comfy_nodes',
  'comfy_logs', 'comfy_templates', 'comfy_workflows',
  // harness/插件生态探测
  'preflight_check', 'plugin_list', 'plugin_inspect', 'telegram_status', 'llm_retry_status',
  'browser_page', 'browser_console',
  // 视觉/标签探测
  'vision_ask', 'vision_compare', 'anima_tag', 'anima_tag_random',
  // WQ 只读探测
  'wq_ping', 'wq_quota', 'wq_similarity_hint', 'wq_check_expression',
  'wq_analyze_parse', 'wq_analyze_classify', 'wq_analyze_similarity', 'wq_analyze_calibrated',
  'wq_knowledge_meme', 'wq_knowledge_templates', 'wq_knowledge_family_tree',
  'wq_knowledge_blindspots', 'wq_knowledge_dead_roots', 'wq_knowledge_summary',
  'wq_status', 'wq_recover_pending',
  // 磁盘/清理探测（只读）
  'clyan_scan', 'clyan_pulse', 'clyan_report', 'clyan_space', 'clyan_space_deep',
  'clyan_history', 'clyan_verify', 'clyan_doctor', 'clyan_app_cache', 'clyan_schedule',
  // 自我观测（探测自己也是探测）
  'skill_signals', 'skill_marks', 'skill_extract',
  'memory_stats', 'memory_health', 'memory_version', 'memory_browse', 'memory_check',
  'context_health', 'context_marks', 'prune_candidates', 'prune_stats',
  'growth_profile', 'emotion_status', 'life_core_status',
  'get_goal', 'job_list', 'job_output', 'session_eject_status',
  'download_list', 'download_status',
  // 记忆检索（5.8 纪律：干活第一拍先 recall——探测自己干过没有）
  'recall', 'memory_relate',
])

/** 行动集：改系统/实施类动作（漏报可接受，误报不可——只收确定性实施动作） */
export const MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write', 'edit',
  'plugin_mount', 'plugin_remove', 'plugin_start', 'plugin_stop', 'plugin_configure', 'plugin_forge',
  'daemon_restart',
  'comfy_run', 'comfy_submit', 'comfy_start', 'comfy_stop', 'comfy_free', 'comfy_upload',
  'checkpoint_restore', 'checkpoint_cleanup',
  'download_add', 'download_control',
  'life_sleep', 'life_core_schedule', 'life_core_pace', 'life_core_selfedit',
  'agent_teams_approve', 'agent_teams_create', 'agent_teams_delete', 'agent_teams_add_member',
])

/**
 * shell 命令动词启发式（v1，粗）：只读动词=探测，写动词=实施，其余 neutral。
 * 启发式偏差方向：拿不准 → neutral（不污染两个信号），宁可漏判不误判。
 */
const SHELL_PROBE_RE = /^\s*(?:Get-|Select-|Where-|Format-|Measure-|Test-|ls\b|dir\b|cat\b|head\b|tail\b|grep\b|rg\b|find\b|stat\b|echo\b|which\b|where\b|df\b|du\b|free\b|uname\b|ipconfig\b|ifconfig\b|ping\b|nslookup\b|curl\s+(?:-I|-s[^"]*\s*$)|node\s+--version|npm\s+(?:ls|view)|python\s+--version)/i
const SHELL_MUTATE_RE = /^\s*(?:Set-|New-|Remove-|Clear-|Move-|Copy-|Rename-|Write-|Add-|Install-|Uninstall-|del\b|rm\b|mv\b|cp\b|mkdir\b|touch\b|kill\b|taskkill\b|chmod\b|chown\b|npm\s+install|pip\s+install|git\s+(?:clone|checkout|commit|push|pull)|curl\s+[^|]*-o\b|wget\b|systemctl\s+(?:start|stop|restart))/i

export function classifyShell(command: string): ToolRole {
  if (SHELL_PROBE_RE.test(command)) return 'probe'
  if (SHELL_MUTATE_RE.test(command)) return 'mutating'
  return 'neutral'
}

/** 工具角色分类（导出供单测）。args 用于 shell 命令动词启发。 */
export function classifyTool(name: string, args?: Record<string, unknown>): ToolRole {
  if (name === 'pwsh' || name === 'wsl') {
    const cmd = args?.command
    return typeof cmd === 'string' ? classifyShell(cmd) : 'neutral'
  }
  if (PROBE_TOOLS.has(name)) return 'probe'
  if (MUTATING_TOOLS.has(name)) return 'mutating'
  return 'neutral'
}

export interface ProbeFirstState {
  startTs: number
  lastTs: number
  calls: number
  actions: number      // mutating 计数
  failures: number
  hadProbeBefore: boolean  // 首个 mutating 判定后冻结
  probeJudged: boolean
  evidenced: boolean
}

export interface ProbeFirstEvidence {
  burstStartTs: string
  calls: number
  actions: number
  failures: number
  hadProbeBefore: false
  probeWindowMs: number
  lastProbeAgeMs: number | null
}

export interface ProbeFirstOptions {
  /** 调用间隔超此值视为新突发（默认 60s） */
  burstGapMs?: number
  /** 突发内 mutating ≥ 此数 = 实施突发（默认 3） */
  minActions?: number
  /** 首个 mutating 前回看多久算「行动前探测」（默认 15 分钟） */
  probeWindowMs?: number
}

export const PROBEFIRST_DEFAULTS = {
  burstGapMs: 60 * 1000,
  minActions: 3,
  probeWindowMs: 15 * 60 * 1000,
}

export interface ProbeFirstTracker {
  lastProbeTs: number
  currentBurst: ProbeFirstState | null
  /** 推进一次工具调用；返回触发的证据（无触发 null）。now 由调用方注入。 */
  feed(name: string, isError: boolean, args: Record<string, unknown> | undefined, now: number, options?: ProbeFirstOptions): ProbeFirstEvidence | null
}

export function createProbeFirstTracker(): ProbeFirstTracker {
  const tracker: ProbeFirstTracker = {
    lastProbeTs: 0,
    currentBurst: null,
    feed(name, isError, args, now, options = {}) {
      const { burstGapMs, minActions, probeWindowMs } = { ...PROBEFIRST_DEFAULTS, ...options }
      const role = classifyTool(name, args)
      if (role === 'probe') tracker.lastProbeTs = now

      let evidence: ProbeFirstEvidence | null = null
      const emit = (): void => {
        if (evidence !== null || tracker.currentBurst === null) return
        const b = tracker.currentBurst
        evidence = {
          burstStartTs: new Date(b.startTs).toISOString(),
          calls: b.calls,
          actions: b.actions,
          failures: b.failures,
          hadProbeBefore: false,
          probeWindowMs,
          lastProbeAgeMs: tracker.lastProbeTs > 0 ? Math.round((b.startTs - tracker.lastProbeTs) / 1000) * 1000 : null,
        }
        b.evidenced = true
      }
      const tryEmit = (): void => {
        const b = tracker.currentBurst
        if (b !== null && !b.evidenced && b.actions >= minActions && !b.hadProbeBefore && b.probeJudged && b.failures >= 1) emit()
      }

      const isNew = tracker.currentBurst === null || now - tracker.currentBurst.lastTs > burstGapMs
      if (isNew) {
        // 结算上一突发
        tryEmit()
        tracker.currentBurst = {
          startTs: now, lastTs: now, calls: 1, actions: 0, failures: isError ? 1 : 0,
          hadProbeBefore: false, probeJudged: false, evidenced: false,
        }
      } else {
        const b = tracker.currentBurst!
        b.lastTs = now
        b.calls += 1
        if (isError) b.failures += 1
      }
      // 首个 mutating：冻结回看判定（行动前窗口内是否有探测）
      const b = tracker.currentBurst!
      if (role === 'mutating') {
        b.actions += 1
        if (!b.probeJudged) {
          b.probeJudged = true
          b.hadProbeBefore = tracker.lastProbeTs > 0 && (now - tracker.lastProbeTs) <= probeWindowMs
        }
      }
      tryEmit()
      return evidence
    },
  }
  return tracker
}
