# Spike M0 — resultados (2026-10-27)

Script: `scripts/spike/spike.mjs` (node-pty puro, Claude Code 2.1.311, `--model haiku`). Resultado bruto em `scripts/spike/result.json`.

| # | Teste | Resultado |
|---|---|---|
| 1 | OSC 7501 | **Funciona.** Basta responder `ESC]7501;?ESC\` à consulta (o Claude só checa `data.startsWith("?")`). Sequência observada: `state=idle` → `working` → `done` → `working` (no /exit) → `clear`. Campos: `state`, `app=claude-code`, `id`, `kind` (só em `blocked`), `progress`, `title`/`msg` em base64. O título da tarefa vem por OSC 0. |
| 2 | Hooks por sessão via `--plugin-dir` | **Funciona.** SessionStart/UserPromptSubmit/Stop chegaram com `COCKPIT_PANE_ID` herdado; `session_id` = o `--session-id` gerado pelo app. Nada é escrito em `~/.claude`. Camada C (`--settings`/editar settings.json) desnecessária. |
| 3 | XTVERSION | O Claude consulta 2×. **xterm.js 6.0.0 não responde** (sem handler `CSI > q`). O main responde `DCSP>|xterm.js(6.0.0)ST`. DECRQM 2026 o xterm.js responde sozinho (synchronizedOutput suportado). |
| 4 | OSC 52 | O Claude copia via `pbcopy` no macOS (setClipboard nativo). **OSC 52 fica bloqueado (leitura e escrita)**, como no Hermes. |
| 5 | Mods com WebGL + customGlyphs | Validar visualmente no app (M1). |
| 6 | Shift+Enter | Validar no app (M1): `\x1b\r`. |
| 7 | Notificação empacotada | Validar no build `--dir` (M2). |
| 8 | Descritores vazando p/ pty | Validar no app (M1): `ls /dev/fd` dentro do pty. |

Consultas que o Claude faz ao iniciar: XTVERSION, `CSI ? u` (kitty keyboard), `OSC 7501;?`, DA1 (barreira), DECRQM 2026 e 1016, `CSI 16 t`.
Modos que ele liga: 25, 2004, 2031, 1004, 1049, 1000/1002/1003/1006, 2026, 1016.
