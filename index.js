/**
 * dsh-win-notify — host plugin (composition edition, v3).
 *
 * Sends Windows native toast notifications (with the system notification
 * sound) when a session needs human attention:
 *   1. TASK COMPLETE — the session agent transitions running→idle, observed
 *      through DSH's built-in `api-session/status` host event;
 *   2. APPROVAL NEEDED — an `approval/request` waterfall event fires while a
 *      tool call waits for the user's decision (the agent does NOT go idle
 *      then, so this hook is what actually covers "I walked away and the
 *      agent is stuck on a permission prompt");
 *   3. QUESTION ASKED — `user-questions/request`, same idea for ask_user_question.
 *
 * Clicking a toast opens `launchUrl` (default: the DSH web GUI).
 *
 * Design constraints (all verified against the live runtime):
 *   - consumes ONLY existing extension points: the `api-session/status`,
 *     `approval/request`, `user-questions/request` events and the
 *     `subprocess` / `timer` / `fs` / `sessions` / `sessionTitle` / `agents` /
 *     `tools` services; it publishes no service;
 *   - toasts are emitted by spawning Windows PowerShell 5.1 through the
 *     `subprocess` service (`-EncodedCommand`, UTF-16LE base64, WinRT
 *     Windows.UI.Notifications); no core modification anywhere;
 *   - dedup: per-session cooldowns (`cooldownMs` for completions, a fixed 3s
 *     for attention toasts); subagent (runtime child) sessions are skipped by
 *     default (`skipSubagentSessions`);
 *   - every side effect belongs to the plugin fiber (ctx.on / ctx.effect /
 *     fiber-owned timers), so unloading the row removes them all;
 *   - a bounded in-memory diagnostics ring (`recentEvents`) records every
 *     received event and toast attempt, exposed through `win_notify_test` —
 *     v3 exists because v2's only live test exercised the spawn path, never
 *     the event path, and silent failures were invisible.
 *
 * Like dsh-annotate, this file imports no `@deepseek-ai/*` package: the test
 * tool is registered by hand as a RAW ToolDefinition through the `tools`
 * service, keeping plugin load independent of the install's module resolution.
 *
 * Config precedence: built-in DEFAULTS ← composition row `config` ←
 * `dsh-win-notify.config.json` found at the host process cwd.
 */

const SOURCE = 'composition'

const DEFAULTS = {
  enabled: true,
  titleTemplate: 'DSH 任務完成',
  bodyTemplate: '{title} 已完成，可以回去看結果了',
  attentionTitle: 'DSH 需要你處理',
  sound: 'default',
  appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  launchUrl: 'http://127.0.0.1:3080',
  notifyOnStart: true,
  cooldownMs: 5000,
  attentionCooldownMs: 3000,
  minRunningMs: 0,
  skipSubagentSessions: true,
  configFileName: 'dsh-win-notify.config.json',
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

function xmlEscape(text) {
  return String(text).replace(/[<>&"']/g, function (ch) {
    if (ch === '<') return '&lt;'
    if (ch === '>') return '&gt;'
    if (ch === '&') return '&amp;'
    if (ch === '"') return '&quot;'
    return '&apos;'
  })
}

function utf16LeBase64(text) {
  let binary = ''
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    binary += String.fromCharCode(code & 0xff, (code >> 8) & 0xff)
  }
  return btoa(binary)
}

function sanitizeConfig(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.titleTemplate === 'string') out.titleTemplate = raw.titleTemplate
  if (typeof raw.bodyTemplate === 'string') out.bodyTemplate = raw.bodyTemplate
  if (typeof raw.attentionTitle === 'string' && raw.attentionTitle !== '') out.attentionTitle = raw.attentionTitle
  if (raw.sound === 'default' || raw.sound === 'silent') out.sound = raw.sound
  if (typeof raw.appId === 'string' && raw.appId !== '') out.appId = raw.appId
  if (typeof raw.powershellPath === 'string' && raw.powershellPath !== '') out.powershellPath = raw.powershellPath
  if (typeof raw.launchUrl === 'string') out.launchUrl = raw.launchUrl
  if (typeof raw.notifyOnStart === 'boolean') out.notifyOnStart = raw.notifyOnStart
  if (typeof raw.cooldownMs === 'number' && isFinite(raw.cooldownMs) && raw.cooldownMs >= 0) out.cooldownMs = raw.cooldownMs
  if (typeof raw.attentionCooldownMs === 'number' && isFinite(raw.attentionCooldownMs) && raw.attentionCooldownMs >= 0) out.attentionCooldownMs = raw.attentionCooldownMs
  if (typeof raw.minRunningMs === 'number' && isFinite(raw.minRunningMs) && raw.minRunningMs >= 0) out.minRunningMs = raw.minRunningMs
  if (typeof raw.skipSubagentSessions === 'boolean') out.skipSubagentSessions = raw.skipSubagentSessions
  if (typeof raw.configFileName === 'string' && raw.configFileName !== '') out.configFileName = raw.configFileName
  return out
}

export const name = 'dsh-win-notify'

/**
 * `subprocess` (the toast spawn) and `timer` (the bounded wait) are hard
 * dependencies — both are always provided by the web profile's base bundle.
 */
export const inject = ['subprocess', 'timer']

/**
 * @param {object} ctx host plugin context
 * @param {Record<string, unknown>} [config] config from the composition row
 */
export function apply(ctx, config = {}) {
  const subprocess = ctx.subprocess

  /* ── state ──────────────────────────────────────────────────────────────── */

  let cfg = Object.assign({}, DEFAULTS, sanitizeConfig(config))
  let configPathUsed = ''
  const idx0 = cfg.powershellPath.lastIndexOf('\\')
  let hostCwd = idx0 > 0 ? cfg.powershellPath.slice(0, idx0) : 'C:\\Windows\\Temp'

  const runningSince = new Map()
  const lastNotified = new Map()
  const recentEvents = []

  function noteEvent(kind, detail) {
    try {
      recentEvents.push({ t: new Date().toISOString(), kind: kind, detail: detail })
      if (recentEvents.length > 40) recentEvents.splice(0, recentEvents.length - 40)
    } catch (error) { /* diagnostics must never break the plugin */ }
  }

  noteEvent('apply', SOURCE)

  /* ── toast spawn (Windows PowerShell 5.1 + WinRT) ───────────────────────── */

  async function showToast(title, body) {
    noteEvent('toast-attempt', title + ' | ' + body)
    const audio = cfg.sound === 'silent' ? '<audio silent="true"/>' : '<audio src="ms-winsoundevent:Notification.Default"/>'
    const openTag = cfg.launchUrl !== ''
      ? '<toast activationType="protocol" launch="' + xmlEscape(cfg.launchUrl) + '">'
      : '<toast>'
    const xml = openTag + '<visual><binding template="ToastGeneric"><text>' + xmlEscape(title) + '</text><text>' + xmlEscape(body) + '</text></binding></visual>' + audio + '</toast>'
    if (xml.indexOf("'") !== -1) {
      noteEvent('toast-fail', 'xml quote guard')
      throw new Error('toast XML unexpectedly contains a single quote')
    }
    // Single-quoted PowerShell string: xmlEscape already turned every ' into
    // &apos;, and LF-only here-strings are unusable under -EncodedCommand.
    const script = [
      '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
      '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null',
      "$xml = '" + xml + "'",
      '$doc = New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$doc.LoadXml($xml)',
      '$toast = New-Object Windows.UI.Notifications.ToastNotification($doc)',
      "$app = '" + cfg.appId.replace(/'/g, "''") + "'",
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show($toast)',
    ].join('\r\n')
    let handle
    try {
      handle = subprocess.spawn({
        argv: [cfg.powershellPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', utf16LeBase64(script)],
        cwd: hostCwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      })
    } catch (error) {
      noteEvent('toast-fail', 'spawn: ' + messageOf(error))
      throw error
    }
    const outcome = await Promise.race([
      handle.done,
      ctx.timeout(15000).then(function () { return null }),
    ])
    if (outcome === null) {
      handle.terminate()
      noteEvent('toast-fail', 'timeout 15000ms')
      throw new Error('toast spawn timed out after 15000ms')
    }
    const stderrReader = handle.collected.stderr
    const stderrTail = stderrReader !== undefined && stderrReader !== null ? stderrReader.readFrom(0).text : ''
    if (outcome.exitCode !== 0) {
      noteEvent('toast-fail', 'exit ' + outcome.exitCode)
      throw new Error('powershell exitCode=' + outcome.exitCode + ' stderr=' + stderrTail.slice(-500))
    }
    noteEvent('toast-ok', 'exit ' + outcome.exitCode)
    return { exitCode: outcome.exitCode, stderrTail: stderrTail.slice(-500) }
  }

  /* ── notification flow ──────────────────────────────────────────────────── */

  async function titleFor(sessionId) {
    let title = ''
    const sessions = ctx.get('sessions')
    const titles = ctx.get('sessionTitle')
    if (sessions !== undefined && titles !== undefined) {
      try {
        const session = sessions.get(sessionId)
        if (session !== undefined && session !== null) {
          const snap = titles.get(session)
          if (snap !== undefined && snap !== null && typeof snap.title === 'string') title = snap.title
        }
      } catch (error) {
        noteEvent('title-lookup-fail', messageOf(error))
      }
    }
    return title !== '' ? title : '未命名 session'
  }

  async function notifySession(sessionId) {
    const displayTitle = await titleFor(sessionId)
    const body = cfg.bodyTemplate.split('{title}').join(displayTitle).split('{sessionId}').join(sessionId)
    await showToast(cfg.titleTemplate, body)
  }

  async function notifyAttention(sessionId, actionText) {
    const displayTitle = await titleFor(sessionId)
    const body = displayTitle + '：' + actionText
    await showToast(cfg.attentionTitle, body)
  }

  function isSuppressedChild(sessionId) {
    const agents = ctx.get('agents')
    if (agents === undefined) return false
    let agent = undefined
    try { agent = agents.get(sessionId) } catch (error) { return false }
    if (agent === undefined || agent === null) return false
    let roots = undefined
    try { roots = agents.roots() } catch (error) { return false }
    if (roots === undefined || roots === null) return false
    for (const root of roots) {
      if (root !== undefined && root !== null && String(root.id) === sessionId) return false
    }
    return true
  }

  function pruneMaps(now) {
    for (const key of lastNotified.keys()) {
      if (now - lastNotified.get(key) > 3600000) lastNotified.delete(key)
    }
    for (const key of runningSince.keys()) {
      if (now - runningSince.get(key) > 3600000) runningSince.delete(key)
    }
  }

  /* ── the event hooks ────────────────────────────────────────────────────── */

  // All three listeners pass {global: true}: cordis' dispatch filters scoped
  // emissions (approval/request, user-questions/request are `this: Scoped<Agent>`)
  // against the LISTENER's context, and a listener registered outside any agent
  // scope would never receive them. global bypasses that filter. Unscoped
  // emissions (api-session/status) pass regardless; the flag is harmless.

  ctx.on('api-session/status', function (sessionId, running) {
    const id = String(sessionId)
    const now = Date.now()
    noteEvent('session-status', id + (running ? ' -> running' : ' -> idle'))
    if (running) {
      runningSince.set(id, now)
      pruneMaps(now)
      return
    }
    runningSince.delete(id)
    try {
      if (!cfg.enabled) { noteEvent('skip', 'disabled'); return }
      if (cfg.skipSubagentSessions && isSuppressedChild(id)) { noteEvent('skip', 'subagent ' + id); return }
      const startedAt = runningSince.get(id)
      if (cfg.minRunningMs > 0 && startedAt !== undefined && now - startedAt < cfg.minRunningMs) { noteEvent('skip', 'minRunningMs ' + id); return }
      const last = lastNotified.get(id)
      if (last !== undefined && now - last < cfg.cooldownMs) { noteEvent('skip', 'cooldown ' + id); return }
      lastNotified.set(id, now)
      pruneMaps(now)
      noteEvent('notify-queued', 'completion ' + id)
      notifySession(id).catch(function (error) {
        console.error('[win-notify] notify failed for session ' + id + ': ' + messageOf(error))
      })
    } catch (error) {
      noteEvent('listener-error', 'session-status: ' + messageOf(error))
      console.error('[win-notify] listener error: ' + messageOf(error))
    }
  }, { global: true })

  // Waterfall: fire-and-forget the toast, then ALWAYS delegate to next().
  function attentionHook(kind) {
    return function (req, next) {
      try {
        if (cfg.enabled) {
          const agentId = req !== undefined && req !== null && req.agent !== undefined && req.agent !== null ? String(req.agent.id) : ''
          const tool = req !== undefined && req !== null && typeof req.toolName === 'string' && req.toolName !== '' ? req.toolName : kind
          noteEvent(kind, agentId + ' ' + tool)
          const now = Date.now()
          const key = 'attention:' + agentId
          const last = lastNotified.get(key)
          if (last === undefined || now - last >= cfg.attentionCooldownMs) {
            lastNotified.set(key, now)
            noteEvent('notify-queued', kind + ' ' + agentId)
            notifyAttention(agentId, (kind === 'user-question' ? '正在等你回答問題' : '需要你的核准：') + tool)
              .catch(function (error) { console.error('[win-notify] attention notify failed: ' + messageOf(error)) })
          } else {
            noteEvent('skip', kind + ' cooldown ' + agentId)
          }
        }
      } catch (error) {
        noteEvent('listener-error', kind + ': ' + messageOf(error))
      }
      return next()
    }
  }

  ctx.on('approval/request', attentionHook('approval'), { global: true })
  ctx.on('user-questions/request', attentionHook('user-question'), { global: true })

  /* ── diagnostic tool (RAW ToolDefinition via the tools service) ─────────── */

  function cfgSummary() {
    return {
      source: SOURCE,
      enabled: cfg.enabled,
      sound: cfg.sound,
      cooldownMs: cfg.cooldownMs,
      attentionCooldownMs: cfg.attentionCooldownMs,
      minRunningMs: cfg.minRunningMs,
      skipSubagentSessions: cfg.skipSubagentSessions,
      notifyOnStart: cfg.notifyOnStart,
      titleTemplate: cfg.titleTemplate,
      bodyTemplate: cfg.bodyTemplate,
      attentionTitle: cfg.attentionTitle,
      launchUrl: cfg.launchUrl,
      appId: cfg.appId,
      powershellPath: cfg.powershellPath,
      configFileName: DEFAULTS.configFileName,
    }
  }

  function sessionCheckFor(exec) {
    const out = { callerKnown: false }
    try {
      const caller = exec !== undefined && exec !== null ? exec.agent : undefined
      if (caller === undefined || caller === null) return out
      const id = String(caller.id)
      out.callerKnown = true
      out.sessionId = id
      const agents = ctx.get('agents')
      if (agents === undefined) { out.agentsService = 'absent'; return out }
      const agent = agents.get(id)
      out.agentLive = agent !== undefined && agent !== null
      if (out.agentLive) {
        const roots = agents.roots()
        out.isRoot = false
        for (const root of roots) {
          if (root !== undefined && root !== null && String(root.id) === id) { out.isRoot = true; break }
        }
        out.suppressedByFilter = cfg.skipSubagentSessions === true && !out.isRoot
      }
    } catch (error) {
      out.error = messageOf(error)
    }
    return out
  }

  const tools = ctx.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    let disposeTool = null
    try {
      disposeTool = tools.register({
        name: 'win_notify_test',
        description: 'Send one Windows toast notification to verify the win-notify plugin pipeline. Returns spawn diagnostics, the effective configuration, the recent event ring (every received DSH event and toast attempt), and whether the CALLING session would be filtered out. Use it when asked to test or diagnose Windows notifications.',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Optional toast title override.' },
            body: { type: 'string', description: 'Optional toast body override.' },
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              ok: { type: 'boolean', description: 'Whether the toast spawned successfully.' },
              exitCode: { type: 'number', description: 'powershell.exe exit code, when ok.' },
              stderrTail: { type: 'string', description: 'Tail of the child stderr.' },
              error: { type: 'string', description: 'Failure message, when ok is false.' },
              hostCwd: { type: 'string', description: 'Host process cwd (the config file lookup base).' },
              configPathUsed: { type: 'string', description: 'Absolute config file path in use, empty when defaults are in effect.' },
              effectiveConfig: { type: 'object', description: 'The effective win-notify configuration.' },
              sessionCheck: { type: 'object', description: 'Whether the calling session is live, a runtime root, and/or filtered by skipSubagentSessions.' },
              recentEvents: { type: 'array', description: 'Bounded ring of received events and toast attempts, newest last.' },
            },
          },
          render: function (_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args, exec) {
          const safe = args && typeof args === 'object' ? args : {}
          const title = typeof safe.title === 'string' && safe.title !== '' ? safe.title : cfg.titleTemplate
          const body = typeof safe.body === 'string' && safe.body !== '' ? safe.body : 'win-notify 測試通知（手動觸發）'
          try {
            const result = await showToast(title, body)
            return { ok: true, exitCode: result.exitCode, stderrTail: result.stderrTail, hostCwd: hostCwd, configPathUsed: configPathUsed, effectiveConfig: cfgSummary(), sessionCheck: sessionCheckFor(exec), recentEvents: recentEvents.slice() }
          } catch (error) {
            return { ok: false, error: messageOf(error), stderrTail: '', hostCwd: hostCwd, configPathUsed: configPathUsed, effectiveConfig: cfgSummary(), sessionCheck: sessionCheckFor(exec), recentEvents: recentEvents.slice() }
          }
        },
      })
      if (typeof disposeTool === 'function' && typeof ctx.effect === 'function') {
        ctx.effect(function () { return disposeTool }, 'win-notify: test tool')
      }
      noteEvent('tool-registered', 'win_notify_test')
      console.log('[win-notify] registered tool "win_notify_test"')
    } catch (error) {
      noteEvent('tool-register-fail', messageOf(error))
      console.error('[win-notify] could not register tool "win_notify_test": ' + messageOf(error))
    }
  } else {
    noteEvent('tool-register-fail', 'tools service unavailable')
    console.error('[win-notify] tools service unavailable; "win_notify_test" not registered')
  }

  /* ── async init: host cwd + config file + startup self-test toast ───────── */

  async function initAsync() {
    const fsSvc = ctx.get('fs')
    if (fsSvc !== undefined) {
      try {
        hostCwd = fsSvc.processPath(await fsSvc.resolve('.'))
      } catch (error) {
        console.error('[win-notify] resolve cwd failed: ' + messageOf(error))
      }
      try {
        const target = await fsSvc.resolve(cfg.configFileName)
        const text = await fsSvc.readText(target)
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          configPathUsed = fsSvc.processPath(target)
          Object.assign(cfg, sanitizeConfig(parsed))
        }
      } catch (error) {
        console.log('[win-notify] config file not loaded (' + messageOf(error) + '); using built-in defaults')
      }
    }
    console.log('[win-notify] active (' + SOURCE + '); cwd=' + hostCwd + '; config=' + (configPathUsed === '' ? 'defaults' : configPathUsed))
    if (cfg.notifyOnStart && cfg.enabled) {
      showToast(cfg.attentionTitle, '已啟用：任務完成、需要核准、等你回答時都會發出 Windows 通知。')
        .then(function (result) {
          console.log('[win-notify] startup toast ok (exitCode=' + result.exitCode + ')')
        })
        .catch(function (error) {
          console.error('[win-notify] startup toast failed: ' + messageOf(error))
        })
    }
  }

  initAsync()
}
