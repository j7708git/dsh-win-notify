// win-notify — DSH 動態 Cordis Plugin（Host 端原始碼）
// 目前以 notify-1/pkg-2 (run-2) 運行中。
// 此檔是 cordis_define 的 code.host 內容：DSH 程序重啟後，可在任何 dsh web session
// 將整個檔案內容交給模型，請它以 cordis_define(kind:"new", idPrefix:"notify") 重新定義並 cordis_run。
//
// 運作：監聽既有事件 api-session/status（由 agent/status 轉發），running=false（agent 轉閒置＝任務完成）
// 時，透過既有 subprocess Service 以 Windows PowerShell 5.1 發出 WinRT 原生 Toast 通知（含系統提示音）。
// 不修改 DSH 核心、不影響其他 plugin；所有選項有內建預設值，可用 dsh-win-notify.config.json 覆寫。

const DEFAULTS = {
  enabled: true,
  titleTemplate: 'DSH 任務完成',
  bodyTemplate: '{title} 已完成，可以回去看結果了',
  sound: 'default',
  appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe',
  powershellPath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  launchUrl: 'http://127.0.0.1:3080',
  notifyOnStart: true,
  cooldownMs: 5000,
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
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
  if (typeof raw.titleTemplate === 'string') out.titleTemplate = raw.titleTemplate
  if (typeof raw.bodyTemplate === 'string') out.bodyTemplate = raw.bodyTemplate
  if (raw.sound === 'default' || raw.sound === 'silent') out.sound = raw.sound
  if (typeof raw.appId === 'string' && raw.appId !== '') out.appId = raw.appId
  if (typeof raw.powershellPath === 'string' && raw.powershellPath !== '') out.powershellPath = raw.powershellPath
  if (typeof raw.launchUrl === 'string') out.launchUrl = raw.launchUrl
  if (typeof raw.notifyOnStart === 'boolean') out.notifyOnStart = raw.notifyOnStart
  if (typeof raw.cooldownMs === 'number' && isFinite(raw.cooldownMs) && raw.cooldownMs >= 0) out.cooldownMs = raw.cooldownMs
  if (typeof raw.minRunningMs === 'number' && isFinite(raw.minRunningMs) && raw.minRunningMs >= 0) out.minRunningMs = raw.minRunningMs
  if (typeof raw.skipSubagentSessions === 'boolean') out.skipSubagentSessions = raw.skipSubagentSessions
  return out
}

return {
  inject: ['subprocess', 'timer'],
  async apply(ctx) {
    const subprocess = ctx.subprocess
    let cfg = Object.assign({}, DEFAULTS)
    let configPathUsed = ''
    let hostCwd = ''

    const fsSvc = ctx.get('fs')
    if (fsSvc !== undefined) {
      try {
        hostCwd = fsSvc.processPath(await fsSvc.resolve('.'))
      } catch (error) {
        console.error('[win-notify] resolve cwd failed: ' + messageOf(error))
      }
    }
    if (hostCwd === '') {
      const idx = cfg.powershellPath.lastIndexOf('\\')
      hostCwd = idx > 0 ? cfg.powershellPath.slice(0, idx) : 'C:\\Windows\\Temp'
    }
    if (fsSvc !== undefined) {
      try {
        const target = await fsSvc.resolve(cfg.configFileName)
        const text = await fsSvc.readText(target)
        const parsed = JSON.parse(text)
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          configPathUsed = fsSvc.processPath(target)
          cfg = Object.assign(cfg, sanitizeConfig(parsed))
        }
      } catch (error) {
        console.log('[win-notify] config file not loaded (' + messageOf(error) + '); using built-in defaults')
      }
    }

    async function showToast(title, body) {
      const audio = cfg.sound === 'silent' ? '<audio silent="true"/>' : '<audio src="ms-winsoundevent:Notification.Default"/>'
      const openTag = cfg.launchUrl !== ''
        ? '<toast activationType="protocol" launch="' + xmlEscape(cfg.launchUrl) + '">'
        : '<toast>'
      const xml = openTag + '<visual><binding template="ToastGeneric"><text>' + xmlEscape(title) + '</text><text>' + xmlEscape(body) + '</text></binding></visual>' + audio + '</toast>'
      if (xml.indexOf("'") !== -1) throw new Error('toast XML unexpectedly contains a single quote')
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
      const handle = subprocess.spawn({
        argv: [cfg.powershellPath, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', utf16LeBase64(script)],
        cwd: hostCwd,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
        graceMs: 5000,
      })
      const outcome = await Promise.race([
        handle.done,
        ctx.timeout(15000).then(function () { return null }),
      ])
      if (outcome === null) {
        handle.terminate()
        throw new Error('toast spawn timed out after 15000ms')
      }
      const stderrReader = handle.collected.stderr
      const stderrTail = stderrReader !== undefined && stderrReader !== null ? stderrReader.readFrom(0).text : ''
      if (outcome.exitCode !== 0) {
        throw new Error('powershell exitCode=' + outcome.exitCode + ' stderr=' + stderrTail.slice(-500))
      }
      return { exitCode: outcome.exitCode, stderrTail: stderrTail.slice(-500) }
    }

    async function notifySession(sessionId) {
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
          console.error('[win-notify] title lookup failed: ' + messageOf(error))
        }
      }
      const displayTitle = title !== '' ? title : '未命名 session'
      const body = cfg.bodyTemplate.split('{title}').join(displayTitle).split('{sessionId}').join(sessionId)
      await showToast(cfg.titleTemplate, body)
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

    const runningSince = new Map()
    const lastNotified = new Map()

    ctx.on('api-session/status', function (sessionId, running) {
      const id = String(sessionId)
      const now = Date.now()
      if (running) {
        runningSince.set(id, now)
        pruneMaps(now)
        return
      }
      runningSince.delete(id)
      try {
        if (!cfg.enabled) return
        if (cfg.skipSubagentSessions && isSuppressedChild(id)) return
        const startedAt = runningSince.get(id)
        if (cfg.minRunningMs > 0 && startedAt !== undefined && now - startedAt < cfg.minRunningMs) return
        const last = lastNotified.get(id)
        if (last !== undefined && now - last < cfg.cooldownMs) return
        lastNotified.set(id, now)
        pruneMaps(now)
        notifySession(id).catch(function (error) {
          console.error('[win-notify] notify failed for session ' + id + ': ' + messageOf(error))
        })
      } catch (error) {
        console.error('[win-notify] listener error: ' + messageOf(error))
      }
    })

    ctx.effect(function () {
      return harness.registerTool(ctx, harness.defineTool({
        name: 'win_notify_test',
        description: 'Send one Windows toast notification to verify the win-notify plugin pipeline. Returns the spawn diagnostics and the effective configuration. Use it when asked to test Windows notifications.',
        parameters: {
          title: { type: 'string', description: 'Optional toast title override.' },
          body: { type: 'string', description: 'Optional toast body override.' },
        },
        output: {
          schema: { type: 'json' },
          render: function (_args, value) { return [{ type: 'text', text: JSON.stringify(value, null, 2) }] },
        },
        async execute(args) {
          const title = typeof args.title === 'string' && args.title !== '' ? args.title : cfg.titleTemplate
          const body = typeof args.body === 'string' && args.body !== '' ? args.body : 'win-notify 測試通知（手動觸發）'
          try {
            const result = await showToast(title, body)
            return { ok: true, exitCode: result.exitCode, stderrTail: result.stderrTail, configPathUsed: configPathUsed, hostCwd: hostCwd, effectiveConfig: cfgSummary() }
          } catch (error) {
            return { ok: false, error: messageOf(error), configPathUsed: configPathUsed, hostCwd: hostCwd, effectiveConfig: cfgSummary() }
          }
        },
      }))
    }, 'win-notify: test tool')

    function cfgSummary() {
      return {
        enabled: cfg.enabled,
        sound: cfg.sound,
        cooldownMs: cfg.cooldownMs,
        minRunningMs: cfg.minRunningMs,
        skipSubagentSessions: cfg.skipSubagentSessions,
        notifyOnStart: cfg.notifyOnStart,
        titleTemplate: cfg.titleTemplate,
        bodyTemplate: cfg.bodyTemplate,
        launchUrl: cfg.launchUrl,
        appId: cfg.appId,
        powershellPath: cfg.powershellPath,
        configFileName: DEFAULTS.configFileName,
      }
    }

    console.log('[win-notify] active; cwd=' + hostCwd + '; config=' + (configPathUsed === '' ? 'defaults' : configPathUsed))

    if (cfg.notifyOnStart && cfg.enabled) {
      showToast(cfg.titleTemplate, '已啟用：session 任務完成時會發出 Windows 通知。')
        .then(function (result) {
          console.log('[win-notify] startup toast ok (exitCode=' + result.exitCode + ')')
        })
        .catch(function (error) {
          console.error('[win-notify] startup toast failed: ' + messageOf(error))
        })
    }
  },
}
