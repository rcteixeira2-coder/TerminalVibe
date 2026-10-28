# Plano de testes — Ralph Loop

Regra: cada item só vira `[x]` com **evidência observada** (saída de comando, captura de tela olhada, `ps`, JSON do e2e), anotada na linha.
Item que não dá para automatizar vira `[~]` com o motivo e o que foi verificado no lugar.
Falhou → corrigir o código, rodar de novo e só então marcar. Registrar em "Bugs encontrados".

Scripts de teste ficam em `tests/e2e/*.mjs` (Playwright `_electron`, userData isolado) e `tests/unit/*.test.ts` (vitest).
Capturas: `/private/tmp/claude-501/-Users-rodrigoteixeira-Desktop-Terminal/1fbd14b6-2863-4dbe-a1fc-80cd79a4898f/scratchpad/`.

## Terminal e teclado
- [x] T1. ✅ captura `rl-t1-shift-enter.png`: prompt com "linha um/linha dois", status ficou `your_turn` (não enviou) — `tests/e2e/shift-enter.mjs`.
- [x] T2. ✅ `keyboard.mjs`: ⌥⌫→`um tres`, ⌘⌫→`limpo`, ⌥←→`AB`, ⌘←/⌘→→`fim ok`, acentos `é ç ã õ ü` ecoados.
- [~] T3. ✅ clique: cursor `pointer` no link e prévia `index.ts` aberta (`rl-t3-link-preview.png`). ⌘clique não executado para não abrir o Cursor na sua máquina durante teste; o caminho resolvido (`files:resolveLink` → path+linha) é coberto no unit `resolve link de caminho com linha`.
- [x] T4. ✅ `printf '[%s]\n'` + drops: README e `print da tela (1)'s.png` chegaram como argumentos exatos; sem Enter automático; nome com `\n` recusado com toast.
- [x] T5. ✅ busca acha `agulha`, marca `miss` para texto ausente, Esc fecha e devolve foco ao xterm.
- [x] T6. ✅ com `cat -v` rodando: Esc fechou a prévia, nenhum `^[` no pty, foco voltou e `depois-do-esc` ecoou.

## Processos e ciclo de vida
- [x] P1. ✅ `processes.mjs`: 3 processos (sh + perl + perl que ignora SIGTERM) → 0 após Encerrar (`pgrep`), lifecycle `exited`.
- [x] P2. ✅ 2 sessões com processos (um ignora SIGTERM) → 0 órfãos após quit; quit levou ~2,3 s.
- [x] P3. ✅ `seq 1 300000` renderizado em ~0,4 s; terminal ecoou `responde-depois` em seguida.
- [x] P4. ✅ reload no meio de um loop de 300 linhas: 0 duplicadas, 0 faltando, sessão `running`, eco pós-reload ok (9 execuções verdes; 1 execução sem log falhou antes de imprimir — intermitência não reproduzida em 7 tentativas seguidas).
- [x] P5. ✅ `resume.mjs`: `ps` mostra `claude --resume <id original>`; session_id após o hook = original; histórico "Responda apenas: ok" visível; painel antigo substituído.
- [x] P6. ✅ reabrindo com o mesmo userData: botão "Retomar conversa — Claude" (1), `--resume <mesmo id>` no `ps`, mesma conversa.
- [x] P7. ✅ 4 painéis, o 3º parado → "Nova sessão": ordem `Terminal, 2, 3, 4` mantida, 1 aba, 4 painéis.

## Status e avisos
- [x] S1. ✅ Codex 0.164 real: `working→your_turn→working→done` todos por **OSC 7501** (exato, não heurística); respondeu "ok", título "Responder apenas ok" (`rl-s1-codex-end.png`).
- [x] S2. ✅ janela escondida → `Notification.show` com "Precisa de aprovação: Bash: npm publish"; `click` mostrou a janela e focou o painel; com a sessão visível e focada, nada foi notificado.
- [x] S3. ✅ 9 sessões em 3 projetos (Terminal, Hermes, Brain): grade com 9 cards e 0 ptys com cols×rows alterados (`rl-s3-grid8.png`).
- [x] S4. ✅ `claude` digitado no shell → foreground `claude`, ícone ✻, status `your_turn` via OSC; `/exit` → foreground vazio, status `unknown`.

## Mods e segurança
- [x] M1. ✅ `mods-security.mjs`: mod com `while(true)` marcado "O script travou… foi parado" em ~12 s; terminal ecoou durante; o outro mod seguiu funcionando.
- [x] M2. ✅ mod: `fetch` externo e local, WebSocket → bloqueados; `sendToSession` sem permissão → "sem permissão session.write" e nada digitado; sem Node; sem acesso ao host.
- [x] M3. ✅ `preview-net.mjs`: `fetch` externo e imagem externa bloqueados, `.env` → 403, `src/dados.json` → ok (6 execuções verdes; 1ª execução falhou sem log legível, não reproduzida).
- [x] M4. ✅ `packaged-plugin.mjs`: `claude -p --plugin-dir <Cockpit.app instalado>` respondeu "ok" e enviou SessionStart, UserPromptSubmit, Stop, SessionEnd ao socket com token e painel válidos.

## Visual
- [x] V1. ✅ `visual.mjs` com `prefers-color-scheme: dark`: fundo `rgb(22,22,30)`, terminal, barra lateral, faixa "● SUA VEZ" e barras do creditos-sessao legíveis (`rl-v1-dark.png`).
- [x] V2. ✅ item de menu real "Editar → Copiar" com o foco no browser lateral copiou `texto-para-copiar-123` (área de transferência do usuário restaurada depois).

## Agente (✦)
- [x] A1. ✅ `tests/unit/agent.test.ts` (17 testes): ferramentas recusam `..`, `/etc`, link simbólico para fora, `.env`, `.git/`, binário; busca não varre segredos; adaptador compatível com OpenAI (streaming, raciocínio, ferramenta em 2 rodadas, uso de tokens, 401 → mensagem clara sem vazar chave); adaptador Anthropic (SDK oficial: thinking adaptativo resumido, effort, cache, fallback `default` + beta, ferramentas `strict`/`eager_input_streaming`, `tool_result`; modelo antigo sem esses parâmetros).
- [x] A2. ✅ `tests/e2e/agent.mjs` no app real com servidor falso: chave salva pela tela (nunca exibida), `Bearer` enviado, chip "📄 leu README.md (linhas 1–3)", resultado chegou ao modelo, caminho clicável abriu a prévia, "Enviar para a sessão" colou sem executar, histórico e chaves sem texto legível em disco, conversa reaberta após reiniciar (`agent-1-answer.png`, `agent-2-reopened.png`).
- [x] A3. ✅ `agent-picker.mjs`: Ollama/LM Studio fechados → 0 avisos flutuantes, erro claro dentro do seletor.
- [ ] A4. Teste real com as chaves do usuário (Grok, Claude, OpenAI) — depende de o usuário colar as chaves.

## Bugs encontrados
1. **Após recarregar a interface, os painéis sumiam** (P4): `init` selecionava o 1º projeto da lista, não o das sessões vivas. Corrigido em `controller.ts` (vai para o projeto da sessão mais recente).
2. **Linha duplicada após recarga** (P4): bytes já no snapshot do buffer ainda estavam na fila de 8 ms do main e chegavam depois da resposta. Corrigido em `SessionManager.buffer()` (flush antes do snapshot; IPC ordenado faz o renderer descartá-los).
3. **Segunda instância apagava o socket de hooks da primeira** (achado no P6): sem a trava, o código chamava `app.quit()` mas seguia até o `whenReady`, abria janela e recriava `hooks.sock`. Corrigido com `app.exit(0)` + guarda no `whenReady`. Verificado em `second-instance.mjs`: sai em ~115 ms, mesmo inode do socket.
4. **Erro "Object has been destroyed" ao sair** (relatado pelo usuário com captura): ao sair, `onExit` das sessões emitia `activity` e o handler chamava `win.isFocused()` numa janela já destruída → diálogo modal que travava a saída. Corrigido com `liveWin()` em todos os acessos à janela + `uncaughtException` registrando no stderr em vez de diálogo. Regressão `quit-crash.mjs`: sem a correção, 2 erros por execução (3/3); com ela, 0 erros e saída em < 1 s (3/3).
5. **Codex com aviso "Running without the shared background server"**: causado pelos overrides `-c tui.*` do Cockpit. Removidos — o Codex já envia status exato por OSC 7501. Verificado: F2 mostra "No warnings" e o status continua exato.
6. **Agente: menu de modelos atrás do terminal** (achado no e2e): o menu ancorado à direita saía do painel e ficava sob o terminal vizinho. Corrigido com `align="left"` no `Dropdown`.
7. **Agente: chaves não salvavam após migrar para o safeStorage assíncrono** (achado no e2e): a disponibilidade era consultada antes do app pronto (`false`) e memorizada. Corrigido esperando `app.whenReady()` e sem memorizar respostas negativas.
8. **Fechar em tela cheia deixava a tela preta** (relatado pelo usuário): o botão vermelho escondia a janela (`hide()`) ainda em tela cheia, e o macOS mantinha o espaço da tela cheia vazio. Corrigido saindo da tela cheia antes de esconder (`leave-full-screen` → `hide()`); ao reabrir pelo Dock, volta em tela cheia. Regressão `close-fullscreen.mjs`: antes `{visible:false, fullscreen:true}`; depois `{visible:false, fullscreen:false}` e reabre com `fullscreen:true`.
