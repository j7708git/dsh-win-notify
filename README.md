# win-notify — DSH 任務完成 Windows 通知 Plugin

當 DSH web session 中的任務完成（session 內 agent 由「執行中」轉為「閒置」）時，在 Windows 桌面發出**原生 Toast 通知**與**系統提示音**；點擊通知可開啟 DSH web GUI。

- **安裝狀態**：已**永久掛載**進 web profile（`~\.dsh\profiles\web`）：`dsh plugin --profile web add` 已完成 pnpm `link:` 依賴＋`dsh.profile.bundles` 附加，`dsh --profile web --dump-config` 組合驗證通過——**每次 DSH 啟動自動載入，開新 session 無需任何交代**
- **歷史**：最初以動態 plugin `notify-1/pkg-2`（run-2）實作並驗證；DSH 程序重啟後動態定義自然消失，由 composition row 接手
- **平台**：純 Host 端（無瀏覽器 UI），不修改 DSH 核心、不影響其他 plugin 與既有行為
- **實作方式**：只掛接 DSH **既有**擴充點——事件 `api-session/status`、Service `subprocess`（spawn PowerShell）、`sessionTitle`／`sessions`（取標題）、`agents`（辨識子 session）、`fs`（讀設定檔）；未臆造任何 API

## 運作原理

v5 覆蓋三種「需要你回來」的時刻：

1. **任務完成**：監聽 Host 事件 `api-session/status(sessionId, running)`（由 DSH 內建 `agent/status` 轉發），`running=false` 即該 session 的 agent 完成回合。已實測事件送達動態與 composition 監聽器。
2. **需要核准**：監聽 `approval/request`（waterfall）——agent 卡在權限核准時**不會**轉閒置，這個掛鉤才是「我離開後 agent 卡住」場景的正解。Toast 內容含工具名稱。
3. **等你回答**：監聽 `user-questions/request`（ask_user_question 提問時）。

> ⚠️ 動態（façade）載入的實測限制：scoped 事件（approval／user-questions）**送不到**動態 plugin 的監聽器（沙箱 façade 不轉發 options、scope 過濾差異）；未 scope 的 `api-session/status` 則正常可達。**composition row（本 repo 的正式安裝方式）用真實 plugin 註冊＋`{global: true}`，重啟後三種事件都應可達**——若重啟後核准通知仍不出現，用 `win_notify_test` 的 `recentEvents` 環判讀（有事件沒 Toast＝渲染問題；沒事件＝送達問題）。

發送方式：以 `subprocess.spawn` 呼叫 Windows PowerShell 5.1（`-EncodedCommand`）。**腳本本體純 ASCII，XML 內容以 UTF-8 base64 內嵌、由腳本解碼**——任何 btoa 實作（規範 Latin-1 或 UTF-8-text shim）下位元組皆正確，徹底排除中文內容導致的間歇性解析失敗。

其他要點：

   - 音效：`ms-winsoundevent:Notification.Default`（系統預設通知音）；可設為靜音
   - 點擊行為：`activationType="protocol" launch=<launchUrl>`（預設開啟 http://127.0.0.1:3080）
   - 去重：任務完成每 session `cooldownMs` 冷卻；核准/提問通知每 session `attentionCooldownMs`（預設 3s）冷卻；可設定跳過子 agent session
   - 啟動時（`notifyOnStart`）發一則「已啟用」通知作為端到端自檢
   - 診斷：`win_notify_test` 回傳 spawn 結果、生效設定、**最近 40 筆事件環**（每個收到的 DSH 事件與每次 Toast 嘗試）、以及「呼叫者 session 是否會被過濾」

## 載入、啟用與移除

本 plugin 已以正式 composition row 永久掛載，之後的重啟與新 session 都**自動生效**：

| 動作 | 方式 |
| --- | --- |
| 啟用 | **重啟 DSH web** 即自動載入（composition row 位於 `~\.dsh\profiles\web`：`package.json` 的 `dependencies` + `dsh.profile.bundles`；本目錄的 `cordis.patch.yml` 為 bundle patch） |
| 驗證已掛上 | `dsh --profile web --dump-config` 尾端應有 `- id: dsh-win-notify`；啟動時桌面出現「已啟用」Toast |
| 暫時停用 | 在 `~\.dsh\profiles\web\cordis.patch.yml` 加一行 `- id: dsh-win-notify\n  disabled: true` 後重啟（或改設定檔 `enabled: false`） |
| 永久移除 | `dsh plugin --profile web remove dsh-win-notify`，並確認 `dsh.profile.bundles` 內該列一併移除，重啟即可 |
| 修改程式 | 直接編輯本目錄 `index.js`（link: 依賴即時反映），重啟 DSH 生效 |

**備援：動態載入**（程序內臨時掛載，重啟即消失；適合不想重啟就想先試改動時）：在 DSH web session 對模型說「請用 cordis_define 建立新 plugin（idPrefix: notify），code.host 使用 `dsh-win-notify/win-notify.host.js` 的內容，然後 cordis_run」。注意：動態版與 composition 版同時存在會重複通知，擇一即可。

## 驗證

| 步驟 | 動作 | 預期結果 |
| --- | --- | --- |
| 1. 啟動自檢 | 啟用 plugin | 右下角出現「已啟用」Toast＋提示音 |
| 2. 手動測試 | 在任何 session 對模型說「用 win_notify_test 發個測試通知」 | Toast 出現；回傳 `ok: true, exitCode: 0` 與生效設定 |
| 3. 實際觸發 | 給任一 session 一個會跑一陣子的任務後離開 | 任務回合結束（agent 轉閒置）時收到「DSH 任務完成」通知，內文含 session 標題 |

沒看到通知時，依序檢查：Windows 設定 → 系統 → 通知（允許「Windows PowerShell」來源）、勿干擾/專注輔助、音量。

## 設定（可配置預設值）

所有項目都有內建預設；可在設定檔覆寫。**設定檔位置＝Host 程序的 cwd**（可用 `win_notify_test` 回傳的 `hostCwd` 確認；本次環境為 `C:\Users\denny`），檔名固定 `dsh-win-notify.config.json`（範例見 `dsh-win-notify.config.example.json`）。優先序：內建預設 ← composition row `config` ← 設定檔。設定在 DSH 啟動時讀取一次，改完**重啟 DSH** 生效。

| 鍵 | 預設 | 說明 |
| --- | --- | --- |
| `enabled` | `true` | 總開關（false 時事件照收但不通知） |
| `titleTemplate` | `DSH 任務完成` | 通知標題 |
| `bodyTemplate` | `{title} 已完成，可以回去看結果了` | 內文模板，`{title}`/`{sessionId}` 會替換 |
| `attentionTitle` | `DSH 需要你處理` | 核准/提問等待時的通知標題 |
| `sound` | `default` | `default`＝系統提示音；`silent`＝靜音 |
| `launchUrl` | `http://127.0.0.1:3080` | 點擊通知開啟的 URL；空字串則不設定 |
| `notifyOnStart` | `true` | 啟用時發一則自檢通知 |
| `cooldownMs` | `5000` | 同一 session 的完成通知去重冷卻（毫秒） |
| `attentionCooldownMs` | `3000` | 同一 session 的核准/提問通知冷卻（毫秒） |
| `minRunningMs` | `0` | 執行至少這麼久才通知（0＝每次完成都通知） |
| `skipSubagentSessions` | `true` | 跳過子 agent session，只通知主 session |
| `appId` | PowerShell AUMID | Toast 來源識別（進階） |
| `powershellPath` | `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` | 進階：Toast 依賴 Windows PowerShell 5.1 的 WinRT；改用 pwsh 7 需自行改寫發送方式 |

## 限制與注意

- 僅適用於**本機 Windows** 執行 DSH 的環境；通知來源會顯示為「Windows PowerShell」（指令稿 Toast 的標準作法）。
- 「任務完成」＝agent 回合結束（含出錯結束的回合），與 DSH 的 goal 機制（`goal/changed`）不同；若要只在 goal 標記 complete 時通知，可在此基礎上再加掛事件。
- 設定檔解析寬鬆：未知鍵與型別不符的鍵會被忽略，不會導致 plugin 失敗。
