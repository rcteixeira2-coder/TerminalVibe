# Plano: app de terminal para Claude e Codex (Electron + node-pty + xterm.js)

Pesquisa só de leitura. Não criei nem alterei nenhum arquivo, nem o arquivo de plano. Conferi o ambiente:
- `/Users/rodrigoteixeira/Desktop/Terminal` está vazia.
- Node é v24.15.0, npm 11.12.1, Mac arm64.
- `claude` 2.1.311 está em `~/.local/bin`. `codex` 0.164.0 está em `~/.local/opt/node/bin`.
- O `npm view` não conseguiu acessar a rede. As versões abaixo são orientação: o M0 fixa as exatas no lockfile.

---

## 0. O que se perde ao deixar o Cursor

**Em resumo: muda o aplicativo. Os recursos que você usa de verdade continuam.**

Tudo do Claude Code fica em `~/.claude` e no CLI, e nada disso depende do Cursor:
- sessões, `--resume` e `/rewind`;
- login, skills, plugins e MCPs;
- hooks, `settings.json` e os mods `atividade-agora` e `creditos-sessao`.

O que os dados do seu Mac mostram:
- **Sessões do Claude:** 815 no total, todas pelo CLI (`entrypoint:"cli"`, mais as `sdk-cli`). Nenhuma foi pelo painel da extensão.
- **Integração `/ide`:** aparece em 1 de 815 sessões. Os diagnósticos do editor nunca foram pedidos (0 chamadas).
- **Cursor Tab:** 0 registros. O Agent/Composer do Cursor teve 6 conversas no total.
- **Editor:** o histórico de edições só tem `settings.json` e `workspace.json`.
- **Extensões:** nenhuma de linguagem. Só `claude-code`, as duas de Remote que vêm de fábrica e o `claude-notifier`.

| O que se perde | Relevância para você | Como o plano resolve |
|---|---|---|
| Visualizar arquivos (o `ide_state.json` mostra .xls, .mp4, .wav, .html, .py) | **Média.** É o uso real do Cursor fora o terminal | Árvore com Quick Look nativo (abre xls/mp4/wav), prévia de imagem, vídeo, áudio e texto no app, e HTML no navegador lateral (M3) |
| Shift+Enter → `\x1b\r` (`keybindings.json`) | **Alta se esquecer** | Já no M1 |
| Som ao terminar (`shouldChimeAfterChatFinishes`) | Média | Notificação do macOS com som por sessão (M2) |
| Aviso do `claude-notifier`: o clique abre o "Visual Studio Code" (`~/.claude/hooks/_lib/click.js:24,29`) | Média, e vai duplicar com os avisos do app | Detectar e oferecer, **com seu consentimento**, `level:"off"`. Nunca editar sozinho (M2) |
| Ponte `/ide` (diff no editor, seleção, erros de lint) | Baixa | Continua funcionando: com o Cursor aberto na mesma pasta, `/ide` conecta a partir de qualquer terminal |
| Editor, Git visual, busca global, debugger, Remote SSH | Baixa | Botão **"Abrir no Cursor"** por projeto e por arquivo, como ação explícita (M3). Visualizador de `git diff` e branch na barra lateral ficam para a fase 2 |
| Tab e Agent do Cursor, `.cursor/rules` | Nenhuma ou quase nenhuma | Claude e Codex fazem esse papel. A regra do MonitoRT já existe como skill |

**Ponto que muda o plano:** o terminal do Cursor **já é xterm.js**. Trocar de app, por si só, não conserta os mods. O que conserta é a configuração.
- No seu Cursor está `gpuAcceleration:"off"`, então os blocos `█ ░ └` são desenhados com a fonte e ficam com frestas.
- O Cursor usa `minimumContrastRatio` 4.5, que reescreve as cores.
- A versão do xterm.js do Cursor pode não suportar DEC 2026, o que faz o redesenho piscar a cada 1 s.
- O app novo resolve com: WebGL + `customGlyphs`, contraste 1, Unicode 11, xterm 6 (que tem DEC 2026) e `pty.resize` só para painéis visíveis.

**Recomendação:** usar o app no dia a dia e manter o Cursor instalado como apoio.

---

## 1. Decisões técnicas

| Área | Escolha | Por quê |
|---|---|---|
| Runtime | `electron`, estável atual fixado | `WebContentsView`, `utilityProcess`, `MessageChannelMain` |
| PTY | `node-pty`, recompilado com `@electron/rebuild` (via `electron-builder install-app-deps` no `postinstall`) | Padrão do VS Code. Atenção ao bit de execução do `spawn-helper` e ao `asarUnpack` |
| Terminal | `@xterm/xterm` 6.x, mais `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-unicode11`, `@xterm/addon-web-links`, `@xterm/addon-search` e `@xterm/addon-serialize` | O serialize é só para miniaturas e reidratação **em memória** |
| Proibidos | `@xterm/addon-clipboard`, `@xterm/addon-image` | Regras de segurança do Hermes |
| Build | `electron-vite` (main, preload e renderer), `typescript` strict | Um único `npm run dev` com recarga rápida |
| UI | `react` 18/19, `react-dom`, `zustand` (estado), `allotment` (divisórias arrastáveis) | Ecossistema grande, fácil de manter com o Claude |
| Persistência | `electron-store` (JSON em `userData`, com schema) | Se a versão for só ESM, o main do electron-vite já é ESM |
| Pacote | `electron-builder`, alvo `mac` / `dmg` / `arm64` | Assinatura ad-hoc (`identity: null`) para uso pessoal |
| Testes | `vitest` (unidade), `@playwright/test` com `_electron.launch` (e2e) | — |
| Lint | `eslint` + `typescript-eslint`, `prettier` | — |

**Nome do app: decisão necessária.** Não chame o produto de "Terminal". Ele colide com o `/System/Applications/Utilities/Terminal.app` da Apple (Spotlight, `open -a Terminal`). A Apple já usa `TERM_PROGRAM=Apple_Terminal`.
- A pasta pode continuar `Desktop/Terminal`.
- Defina um `productName` e um `appId` próprios, por exemplo `com.rteixeira.<nome>`.
- Abaixo, o nome aparece como `<App>`.

---

## 2. Arquitetura de processos

```
main (Node)
 ├─ PtyManager         spawn/kill/resize; ring buffer de 2 MB por sessão (só memória);
 │                     árvore de processos (ps a cada 0,4 s); powerSaveBlocker
 ├─ StatusEngine       junta as camadas A–D → Session.activity; emite eventos
 ├─ HookSocketServer   net.Server unix socket 0600 → StatusEngine
 ├─ ProjectScanner     Desktop + adicionadas + favoritas; fs.watch na Desktop
 ├─ FileTreeService    readdir preguiçoso, isInside, previewFile, menus
 ├─ LaunchService      LaunchTargets (porte de LaunchTargets.swift) + detecção de localhost
 ├─ BrowserManager     um WebContentsView por projeto, partição em memória
 ├─ ModsHost           carrega ~/.<app>/mods, um WebContentsView sandbox oculto por mod
 ├─ Notifier           Notification + som + dedupe
 └─ Store              electron-store (projetos, layout, preferências)
preload (contextBridge)  window.api tipado: invoke/on por canal com validação
renderer (React, sandbox) Sidebar, Tabs, Split, Grid, TerminalView, FileTree, BrowserDock, ModSlots
```

- Janela principal com `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false` e `webSecurity:true`.
  - CSP: `default-src 'self'; script-src 'self'; connect-src 'self'`.
  - `will-navigate` bloqueado e `setWindowOpenHandler` → deny.
- **Fluxo de dados do PTY:**
  - Cada sessão ganha um `MessageChannelMain`, com uma porta passada ao renderer. Isso evita o ipc genérico.
  - O main junta a saída em blocos de 8 ms ou 64 KB.
  - Controle de fluxo: o renderer devolve "ack" pelo callback do `term.write`. O main pausa o pty acima de 1 MB pendente e retoma abaixo de 256 KB.
- `utilityProcess` para o PtyManager fica para o M5 (isolar travamentos). No MVP ele fica no main.

---

## 3. Estrutura de pastas

```
Terminal/
  package.json  electron.vite.config.ts  electron-builder.yml  tsconfig*.json
  resources/   icon.icns  hooks/report.sh  fonts/<mono com ▶◷●○►└█░…>.woff2
  src/shared/      types.ts (Project, Session, Layout, eventos), ipc.ts (contrato dos canais),
                   status.ts (enums + mapa evento→estado), links.ts (validação de URL)
  src/main/        index.ts  window.ts  menu.ts  store.ts  security.ts (env, isInside, quote)
                   pty/{PtyManager,processTree,ringBuffer,resolveBinary}.ts
                   status/{StatusEngine,osc7501,hookServer,claudeSettings,heuristics}.ts
                   projects/{scanner,launchTargets,localhost}.ts
                   files/{fileTree,preview}.ts
                   browser/BrowserManager.ts
                   mods/{ModsHost,manifest,permissions,modProtocol}.ts
                   notify/Notifier.ts
  src/preload/     index.ts  mod-preload.ts
  src/renderer/    main.tsx  App.tsx  state/*.ts
                   components/{Sidebar,ProjectItem,SessionBadge,TabBar,SplitArea,
                     GridView,TerminalView,EmptyState,FileTree,FilePreview,BrowserDock,ModSlot}.tsx
                   terminal/{createTerminal,keymap,oscHandlers,theme}.ts
  tests/unit/*.test.ts   tests/e2e/*.spec.ts   tests/fixtures/
```

---

## 4. Modelo de dados (`src/shared/types.ts`)

```ts
type Agent = 'claude' | 'codex' | 'shell';
type Lifecycle = 'idle'|'running'|'stopping'|'exited'|'interrupted'|'failed'; // igual ao Hermes
type Activity = 'unknown'|'working'|'your_turn'|'needs_approval'|'done'|'error';
interface Project { id: string /*realpath*/; name; path; source:'desktop'|'added'; favorite:boolean;
  color:string; lastAgent?:Agent; showTree:boolean; launchTarget?:string; browserHidden:boolean }
interface Session { id:string /*= TERMINAL_PANE_ID, UUID*/; projectId; agent:Agent; title:string /*"Claude 2"*/;
  lifecycle:Lifecycle; activity:Activity; activityDetail?:string; claudeSessionId?:string;
  pid?:number; startedAt:number; lastOutputAt:number; cols:number; rows:number; color:string }
interface ProjectLayout { tabs: { id; sessionIds:string[] /*≤4 painéis*/; sizes:number[] }[]; activeTabId }
interface Layout { view:'project'|'grid'; activeProjectId?; perProject: Record<string,ProjectLayout>;
  grid: { sessionIds:string[]; columns:number } }
```

- **Persistido:**
  - projetos adicionados e favoritos, cor, `lastAgent`;
  - preferências de painel;
  - layout;
  - `openSessions` (projeto e tipo) gravado no `before-quit`, para oferecer "Retomar".
- **Nunca persistido:** buffer, saída e logs do pty.

---

## 5. Sessões e PTY (porte do Hermes)

- **Binário:** `resolveBinary` procura `claude` e `codex` no PATH montado, com `fs.accessSync(X_OK)`, e chama `pty.spawn(absPath, args, { cwd: realpath(projeto), env, cols, rows })`. Nunca `zsh -c`.
  - Argumentos do shell: `/bin/zsh -il`.
  - Retomar: `claude --resume` e `codex resume`.
  - Codex recebe também `-c tui.notifications=true -c tui.notification_method=osc9 -c tui.notification_condition=always`.
  - Nenhuma flag que pule permissões. Um teste garante isso.
- **Ambiente** (`security.ts:buildEnv`), montado de uma lista branca:
  - copia USER, LOGNAME, LANG, LC_CTYPE e TMPDIR;
  - PATH fixo do Hermes mais o herdado, só caminhos absolutos;
  - `HOME`, `SHELL=/bin/zsh`, `LANG=pt_BR.UTF-8` (padrão), `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=<App>`, `TERM_PROGRAM_VERSION`;
  - `TERMINAL_PANE_ID`, `TERMINAL_SOCK`, `TERMINAL_APP_TOKEN`.
  - **Removidas explicitamente:** `CURSOR_TRACE_ID`, `VSCODE_*`, `TERM_PROGRAM*` herdados, `__CFBundleIdentifier`, `ELECTRON_*`, `NODE_OPTIONS`, `DYLD_*` e tokens.
  - Sem isso, o Claude acha que está no Cursor quando você roda o app de dentro do Cursor.
- **Regras de sessão:**
  - Uma principal por tipo. Escolher um tipo inicia a sessão se ela estiver idle.
  - Até 4 painéis, mínimo de 260 px cada. O botão fica desabilitado no limite, com "Até 4 terminais".
  - Títulos numerados quando repetem. Cada início cria um `Terminal` novo.
- **Ações:**
  - Interromper: `\x03`.
  - Encerrar: porte do `DevProcessTree`. `ps -axo pid=,ppid=,lstart=` a cada 0,4 s guarda identidade (PID + horário de início), depois STOP → coleta de novo → TERM → CONT → KILL após 0,6 s, conferindo a identidade antes de cada sinal.
  - Órfãos são mortos quando o líder sai.
- **Sobrevivência:**
  - Fechar a janela só esconde (`close` → `hide`).
  - `powerMonitor` `suspend` e `user-did-resign-active` chamam `stopAll` e marcam interrupted.
  - `before-quit`, SIGTERM e SIGINT chamam `stopAll`.
  - Na abertura, as sessões voltam como interrupted com "Retomar conversa". Pedidos nunca são reenviados.
- **Repouso:** `powerSaveBlocker.start('prevent-app-suspension')` enquanto houver pelo menos uma sessão rodando.
- **Redimensionamento:** fit com debounce de 80 ms, e `pty.resize` só para o painel visível e focado na área principal. Escondido ou miniatura nunca redimensiona.

---

## 6. Terminal (renderer, `createTerminal.ts`)

Opções:
- `fontFamily` com a fonte embutida e fallback `SF Mono, Menlo`; `fontSize: 13`; `lineHeight: 1`; `letterSpacing: 0`;
- `customGlyphs: true`, `rescaleOverlappingGlyphs: true`, `minimumContrastRatio: 1`;
- `scrollback: 10000`, `scrollSensitivity: 3`;
- `macOptionIsMeta: false`, `macOptionClickForcesSelection: true`, `allowProposedApi: true`;
- `windowOptions` padrão (nenhum relatório de título);
- tema com paleta ANSI 16 própria, ligado ao `nativeTheme`.

Addons:
- Ordem: WebGL, depois Unicode11 (`activeVersion='11'`), Fit, Search e WebLinks com handler validado.
- `onContextLoss` → descarta e volta ao renderizador DOM.
- Limite de 12 contextos WebGL. Os painéis acima disso usam DOM.

**Decisão sobre `macOptionIsMeta`:** as pesquisas divergem. Fica `false`, porque preserva os acentos do português. Os atalhos de Option vêm do keymap abaixo.

Keymap (`attachCustomKeyEventHandler`; nada é capturado se `e.isComposing`):

| Tecla | Envia |
|---|---|
| Shift+Enter | `\x1b\r` |
| ⌥⌫ | `\x1b\x7f` |
| ⌘⌫ | `\x15` |
| ⌥⌦ | `\x1bd` |
| ⌥← / ⌥→ | `\x1bb` / `\x1bf` |
| ⌘← / ⌘→ | `\x01` / `\x05` |

Esc, Ctrl+C e Ctrl+V passam direto.

Handlers do parser (`oscHandlers.ts`). Todos descartam payload acima de 64 KB:
- **OSC 7501:** responde à consulta `?` e repassa o estado ao StatusEngine pelo IPC (camada A).
- **OSC 9 / OSC 777:** viram notificação. **BEL:** marca "atenção".
- **OSC 52:** leitura sempre negada. Escrita: o Hermes nega, mas o modo fullscreen do Claude pode depender dela para copiar.
  - Proposta: preferência com padrão "permitir escrita até 64 KB, com aviso discreto 'copiado'".
  - O M0 valida se o Claude usa OSC 52 para copiar.
- **Kitty clipboard:** engolido.
- **XTVERSION (`CSI > q`):** responder `DCS >|xterm.js(6.x) ST` só se o xterm.js não responder sozinho (validar no M0).
- **OSC 8:** `linkHandler.activate` → IPC → main valida (http/https, com host, sem credenciais) → `shell.openExternal`.
- **Título:** `onTitleChange` só aparece como rótulo secundário. Nunca vira título da janela nem volta como entrada.

Outros comportamentos:
- **Arrastar arquivo** para o terminal → caminho entre aspas simples (`'` vira `'\''`), mais um espaço, sem Enter.
- **Foco:** `term.focus()` no mousedown. `lastFocusedSessionId` serve para "Inserir caminho".

---

## 7. Status de cada sessão

```
pty bytes ─▶ (renderer) OSC 7501/9/777/BEL ─IPC─▶ StatusEngine ◀─ HookSocketServer ◀─ report.sh ◀─ hooks do Claude
                                                    ▲                (TERMINAL_PANE_ID, token)
                       heurísticas (saída, vida do processo, título) ┘
StatusEngine ─▶ Session.activity ─▶ renderer (selo) + Notifier + ModsHost.onSessionEvent
```

**Prioridade** de cada sessão: A (OSC 7501) > B (hooks) > D (heurística). Estado "fresco" é o que chegou nos últimos 30 s; depois disso a camada seguinte assume.

**Camada A, OSC 7501:**
- Mapeamento:
  - `working` → trabalhando;
  - `blocked:permission` → precisa de aprovação;
  - `blocked:question` ou `auth` → sua vez;
  - `done` e `idle` → sua vez, com "terminou";
  - `error` → erro;
  - `clear` → encerrada.
- O título e a mensagem em base64 viram `activityDetail`.
- Protocolo não documentado. Por isso o M0 valida e há uma chave para desligar.

**Camada B, hooks sem tocar em `~/.claude`:**
- O app gera `userData/claude-hooks.json` e inicia `claude --settings <arquivo>`.
- O arquivo tem `"async": true` em UserPromptSubmit, PreToolUse, PostToolUse, PermissionRequest, Notification, Stop, StopFailure, SessionStart e SessionEnd, todos chamando `resources/hooks/report.sh`.
- `report.sh`, sem depender de Node:

  ```sh
  [ -z "$TERMINAL_PANE_ID" ] && exit 0
  { printf '%s %s\n' "$TERMINAL_APP_TOKEN" "$TERMINAL_PANE_ID"; cat; } | nc -U -w1 "$TERMINAL_SOCK" >/dev/null 2>&1
  exit 0
  ```

- **Socket:** `~/Library/Application Support/<App>/run/hooks.sock`, pasta 0700, arquivo 0600.
  - Conferir se o caminho tem menos de 104 bytes.
  - O token, aleatório a cada abertura do app, é comparado em tempo constante.
  - Payload máximo de 256 KB, com JSON validado.
- **Mapa de eventos:**
  - UserPromptSubmit, Pre/PostToolUse → trabalhando;
  - PermissionRequest e `Notification[permission_prompt]` → aprovação;
  - `PreToolUse[AskUserQuestion]`, `Notification[idle_prompt | agent_needs_input | elicitation_dialog]`, `ExitPlanMode` → sua vez ("Plano pronto" ou "pergunta", textos do `DevRemote.swift:70-89`);
  - `Stop` com `background_tasks` vazio → terminou;
  - StopFailure → erro;
  - SessionEnd → encerrada;
  - SessionStart reassocia o `session_id`, porque o `/clear` troca o id.
- **Se o `--settings` não somar os hooks** (a validar no M0), entra a camada C. Ela fica para o M5 e só com consentimento:
  - um plugin `~/.claude/mods/<app>-status` com `hooks/hooks.json`;
  - mais duas chaves em `settings.json`, gravadas com parse, backup com data e hora, marcador `/<App>/hooks/report`, escrita idempotente e atômica, conferência de mtime e desinstalação limpa.

**Camada D, Codex e shell:**
- OSC 9 vindo do Codex → sua vez ou terminou.
- Saída nos últimos 1,5 s → trabalhando.
- Silêncio acima de 4 s depois de atividade → sua vez (provável).
- Saída do processo: código 0 → terminou, diferente de 0 → erro.
- Shell: só a lifecycle, mais OSC 133 opcional.
- No MVP, o status do Codex é "melhor esforço" e aparece marcado assim.

**Fallback por transcript** (porte do `DevSessionReader`): só se A e B estiverem ausentes. Lê `~/.claude/projects/<cwd sanitizado>` apenas para leitura.

---

## 8. Notificações

- `Notifier` no main dispara em needs_approval, your_turn, done e error.
  - Só quando a janela não está em foco **ou** a sessão não está visível.
  - Ignora repetições do mesmo estado da mesma sessão por 10 s.
  - Som configurável, ligado por padrão para substituir o som do Cursor.
- **Clique:** mostra a janela, seleciona o projeto e a aba, foca o painel.
- **Selo do Dock:** número de sessões em needs_approval mais your_turn, via `app.dock.setBadge`.
- **Duplicação com o claude-notifier:**
  - Se `~/.claude/hooks/claude-notifier-config.json` existir com nível ativo, o app mostra um banner: "Avisos duplicados: desligar os do claude-notifier?".
  - Opções: [Desligar] (edição com backup, só com o clique) ou [Deixar o app em silêncio].
  - O `click.js` aponta para o VS Code. O app não edita esse arquivo; o banner apenas explica.

---

## 9. Projetos, grade e abas

- **Barra lateral:**
  - Seções Favoritos, Mesa e Adicionadas. A Mesa ignora pastas ocultas e pacotes e é vigiada com `fs.watch`.
  - Cada projeto mostra sua cor, um selo agregado (o estado mais urgente: aprovação > erro > sua vez > trabalhando > terminou) e a lista de sessões com o estado de cada uma.
  - Menu do projeto: favoritar, cor, Mostrar no Finder, **Abrir no Cursor** (`execFile('open', ['-a','Cursor', path])`) e Remover (só as adicionadas).
  - Adicionar: `dialog.showOpenDialog({properties:['openDirectory'], defaultPath: Desktop})`.
- **Visão do projeto:**
  - Barra de abas coloridas com a cor do projeto. Abas dentro do projeto, cada uma com até 4 painéis em `allotment`.
  - Barra do painel: bolinha, título e estado, mais Interromper/Encerrar ou Retomar/Nova.
  - Tela vazia: "Escolha como trabalhar neste projeto", com Abrir Claude, Codex e Terminal.
- **Grade (⌘G):**
  - Todas as sessões de todos os projetos, ou filtradas por estado.
  - Cada célula mostra o terminal na cols×rows real, reduzido com `transform: scale` e em modo só leitura (sem `pty.resize`), com borda na cor do projeto e o selo de estado.
  - Clique ou Enter abre a sessão.
  - Células acima do limite de WebGL usam DOM.
  - Ordenação "precisa de mim primeiro".

---

## 10. Navegador lateral

- **`BrowserManager`:** um `WebContentsView` por projeto, adicionado como filho da janela à direita da área de terminais. A largura é ajustável e fica salva.
  - Partição `browser:<projectId>`, sem `persist:`, só em memória.
  - `sandbox`, sem preload.
  - Barra própria no renderer: recarregar, URL, abrir no navegador padrão, fechar.
- **Detecção de localhost:**
  1. Regex na saída do pty (sem ANSI) dos painéis do projeto: `https?://(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):(\d{2,5})`. `0.0.0.0` é reescrito como `localhost`.
  2. Enquanto houver um painel de servidor rodando, a cada 2 s: `lsof -a -nP -iTCP -sTCP:LISTEN -p <pids da árvore>`.
  3. A primeira porta nova abre o painel sozinho, se o navegador não estiver escondido para aquele projeto.
- **Navegação permitida:** `http://localhost:*`, `http://127.0.0.1:*` e o protocolo próprio `preview://<projectId>/…`.
  - O `protocol.handle` faz `realpath` e `isInside` antes de servir o arquivo.
  - O resto passa por `will-navigate` → `preventDefault`, e `shell.openExternal` só para http/https.
  - `setWindowOpenHandler` → deny + externo.
- **HTML local:** porte do `Preview.swift`.
  - `fs.watch(root, {recursive:true})` com debounce de 800 ms e a lista de ignorados do `PreviewFiles.swift:40-51`.
  - A rolagem é mantida com `executeJavaScript` antes e depois do recarregamento.
  - Escolha da página: a lembrada, senão `index.html`, senão a única, senão a mais recente.
- **Botão play (LaunchTargets):**
  - Varre apps, scripts `dev`/`start` e `.html` até 2 níveis.
  - Gerenciador de pacotes pelo arquivo de lock, com `install` se faltar `node_modules`.
  - O servidor roda num painel novo de shell, digitando o comando montado só com palavras fixas.
  - Um app Mac abre via `open`, por ação explícita sua.
  - A escolha fica salva por projeto.

---

## 11. Árvore de arquivos e prévia

- **Porte fiel do Hermes:**
  - Um nível por vez, até 2000 itens por pasta mais a linha "… mais N", pastas primeiro.
  - Ordem com `Intl.Collator('pt-BR',{numeric:true})`. Ocultos em cinza. Pacotes contam como arquivo.
  - Links simbólicos aparecem com ícone, mas não são seguidos.
  - `isInside` usa `realpath` em todos os níveis.
  - Botões Atualizar e Recolher tudo. Largura de 180 a 300, salva.
- **Prévia** (o uso real do Cursor):
  - Duplo clique ou Espaço → `win.previewFile(path)`, o Quick Look nativo.
  - Painel "Prévia" no app para imagem, vídeo, áudio e texto/código até 1 MB (texto puro com fonte mono; destaque de sintaxe fica para o M5).
  - Tudo servido por `preview://` com a mesma checagem.
- **Menu de contexto:** Pré-visualizar, Ver no navegador (HTML), Mostrar no Finder, Copiar caminho, Inserir caminho no terminal e **Abrir no Cursor**.
- **Sem `shell.openPath`** (regra do Hermes: o app nunca abre nem executa arquivos). O Quick Look e o "Abrir no Cursor" cobrem o seu uso.

---

## 12. Sistema de mods do app

Os mods do app são diferentes dos mods do Claude Code (`~/.claude/mods`), que rodam dentro do próprio Claude e que o app não toca.

- **Onde ficam:** `~/.<app>/mods/<id>/`, com `manifest.json`, `main.js` e `panel.html` opcional.
- **Manifesto:**

  ```json
  { "id":"exemplo", "name":"Exemplo", "version":"1.0.0", "main":"main.js",
    "permissions":["ui.sidebarButton","ui.panel","commands","session.events","session.write"],
    "panels":[{"id":"p1","title":"Meu painel","html":"panel.html","location":"right"}] }
  ```

- **Isolamento:**
  - Cada mod roda num `WebContentsView` oculto com `sandbox:true`, `contextIsolation:true`, sem `nodeIntegration`, partição em memória `mod:<id>`, protocolo `mod://<id>/` restrito à pasta do mod e CSP `default-src 'none'; script-src mod:; style-src mod: 'unsafe-inline'`.
  - Sem rede (`session.webRequest` bloqueia tudo que não seja `mod:`).
  - O `mod-preload.ts` expõe apenas `window.app`, que fala com o `ModsHost` por `MessagePort`.
  - Painéis de mod são outro `WebContentsView` sandbox com o mesmo preload.
- **API**, em que cada chamada confere a permissão do manifesto:
  - `addSidebarButton({icon,label,onClick})`
  - `addPanel({id,html})`, `postToPanel`
  - `registerCommand({id,title,shortcut?})`, que aparece na paleta ⌘K
  - `onSessionEvent(cb)`, que recebe `{sessionId, projectId, agent, activity, lifecycle, detail}`. Nunca recebe o conteúdo do terminal.
  - `sendToSession(sessionId, text)`
  - `listSessions()`, `notify(title, body)`
- **Regras do `sendToSession`:**
  - Exige permissão `session.write`, confirmada por você na primeira vez para cada mod.
  - Limite de 4 KB por chamada e 1 chamada por segundo.
  - Remove caracteres de controle, exceto `\r`, `\n` e `\t`.
  - Mostra o selo "mod digitou" no painel.
- **Gestão:** tela de Mods para ligar/desligar, ver permissões e recarregar. Um erro no mod não derruba o app: o `ModsHost` reinicia a view com backoff.
- **Mod de exemplo:** "Aprovações pendentes", um botão na barra lateral que lista as sessões em needs_approval.

---

## 13. Segurança

Herdada do Hermes, com equivalentes no Electron:
- **Ambiente:** lista branca com limpeza das variáveis de IDE (§5).
- **Arquivos:** árvore e prévia confinadas com `realpath` + prefixo. Arquivos nunca são executados.
- **Links:** só http/https com host, sem credenciais, só com clique.
- **Clipboard:** OSC 52 de leitura negado; escrita conforme a decisão da §6. Sem addons de clipboard e de imagem.
- **Título:** nunca volta como entrada (CVE-2022-23465).
- **Sem gravação:** nada do terminal vai para o disco, e não há logs do pty.
- **Navegador:** partição em memória.
- **Permissões:** nenhuma flag que pule permissões.
- **Descritores:** testar no M1 se descritores privados vazam para o pty (`ls /dev/fd` dentro do pty).
- **Processos do Electron:**
  - O IPC valida o tipo de cada mensagem; `projectId` e `sessionId` precisam existir.
  - `sandbox` em todos os renderers.
  - `app.enableSandbox()`, `webContents.setWindowOpenHandler` global e `will-attach-webview` bloqueado.
  - Fuses do electron-builder: `runAsNode:false`, `enableNodeOptionsEnvironmentVariable:false`, `onlyLoadAppFromAsar:true`.

---

## 14. Atalhos de teclado

| Atalho | Ação |
|---|---|
| ⌘T | nova aba (shell) |
| ⌘D | dividir (shell) |
| ⌘⇧D | dividir com escolha de tipo |
| ⌘1…9 | ir para o projeto N da barra lateral |
| ⌘⌥← / ⌘⌥→ | painel anterior / próximo |
| ⌘G | grade |
| ⌘B | barra lateral |
| ⌘E | árvore de arquivos |
| ⌘⇧B | navegador |
| ⌘K | paleta de comandos (inclui comandos de mods) |
| ⌘F | buscar no terminal |
| ⌘W | fecha a janela (sem matar sessões) |
| ⌘⇧W | encerrar a sessão do painel (com confirmação se estiver rodando) |
| ⌘. | Interromper (`^C`) |
| ⌘J | ir para a próxima sessão que precisa de mim |
| ⌘C / ⌘V | copiar a seleção do xterm / colar |

As teclas de terminal das §5 e §6 têm prioridade quando o terminal está em foco.

---

## 15. Marcos

**M0, base e testes de risco (1 a 2 dias)**
- Criar com `npm create @quick-start/electron` (template react-ts), node-pty recompilado e electron-builder arm64 com uma janela só.
- Fazer `scripts/spike.ts`, um painel único com Claude, para validar:
  1. a resposta e o formato do OSC 7501;
  2. se o `--settings` soma os hooks;
  3. se o xterm.js 6 responde ao XTVERSION;
  4. se o Claude fullscreen usa OSC 52 para copiar;
  5. os mods `atividade-agora` e `creditos-sessao` com WebGL + customGlyphs, sem listras nem frestas;
  6. Shift+Enter.
- **Aceite:** `npm run dev` abre a janela. `npm run build:mac` gera um `.dmg` que abre. Os 6 itens do spike ficam registrados em `docs/spike.md`. Esse é o único arquivo de documentação do projeto; ele não é um relatório.

**M1, terminal sólido**
- PtyManager, `buildEnv`, `resolveBinary`, árvore de processos e encerramento, lifecycle, keymap, handlers OSC de segurança, painéis divididos até 4, regras de sobrevivência, `powerSaveBlocker`, menus.
- **Aceite:**
  - Claude, Codex e zsh abrem na pasta certa.
  - Os acentos funcionam e ⌥← pula palavra.
  - `vim` e `htop` aparecem perfeitos.
  - Encerrar mata `npm run dev` e os netos dele (conferir com `ps`).
  - Fechar a janela e reabrir mantém as sessões.
  - ⌘Q mata tudo.
  - `env` dentro do pty não mostra `CURSOR_*`, `VSCODE_*`, `NODE_OPTIONS` nem tokens.

**M2, projetos, status e notificações**
- Scanner, barra lateral com favoritos e cores, abas, StatusEngine (A, B e D), socket, `report.sh`, Notifier, selo do Dock, banner do claude-notifier, grade.
- **Aceite:**
  - Pedir ao Claude algo que exija permissão → o selo vira "aprovação" em menos de 1 s e aparece uma notificação. O clique foca o painel certo.
  - Ao terminar → "sua vez/terminou" com som.
  - `/clear` mantém a associação.
  - Codex mostra "trabalhando" e "sua vez" por OSC 9 ou heurística.
  - 8 sessões em 3 projetos aparecem na grade sem o pty encolher.

**M3, arquivos e Cursor**
- FileTree, Quick Look, painel de prévia, menus, inserir caminho, arrastar arquivo, "Abrir no Cursor".
- **Aceite:**
  - Links simbólicos para fora não são seguidos.
  - `..` é recusado.
  - xls, mp4 e wav abrem no Quick Look.
  - O caminho com aspas cai no último terminal focado.

**M4, navegador e play**
- BrowserManager, `preview://`, detecção de localhost (regex + lsof), LaunchTargets, recarga ao vivo de HTML.
- **Aceite:**
  - `npm run dev` num projeto Vite abre o painel com a porta certa.
  - Links externos vão para o navegador padrão.
  - Recarregar mantém a rolagem.
  - Fechar o app não deixa cookies salvos.

**M5, mods e acabamento**
- ModsHost, manifesto, permissões, tela de Mods, mod de exemplo, paleta ⌘K.
- Persistir e restaurar sessões interrompidas ("Retomar").
- Camada C (se o M0 mostrar que é necessária), PtyManager em `utilityProcess`, destaque de sintaxe, preferências, ícone.
- **Aceite:**
  - O mod de exemplo funciona.
  - Um mod sem `session.write` recebe erro ao tentar digitar.
  - Um mod com `while(true)` não trava o app.
  - Reabrir o app mostra "Retomar conversa" nas sessões que estavam abertas.

---

## 16. Verificação

**Como rodar:** `npm install` (recompila o node-pty), `npm run dev`, `npm run test`, `npm run test:e2e` e `npm run build:mac` (gera `dist/*.dmg`).

**Unidade (vitest):**
- `buildEnv`: lista branca, limpeza das variáveis de IDE e PATH sem `.`.
- `quotePath`: aspas e `'\''`.
- `isInside`: casos de `..` e de link simbólico, copiados de `Hermes/Tests/Dev/main.swift:152-162`.
- `validateLink`: bloqueia `file:`, `javascript:`, `vscode:`, credenciais.
- Parser do OSC 7501, incluindo o base64.
- Mapa evento → estado, incluindo `background_tasks`.
- Regex de localhost.
- `launchTargets`, usando fixtures.
- Prioridade e frescor do StatusEngine.
- Validação do manifesto de mod.
- Árvore de processos com um `ps` falso.
- Ausência de flags que pulam permissões nos argumentos.

**E2E (Playwright com `_electron.launch`):**
- Abrir um projeto fixture, iniciar o shell, `echo ok`, ver a saída.
- Dividir até 4 e verificar o botão desabilitado.
- Escrever no socket um JSON de PermissionRequest com o token → o selo muda.
- Grade com 3 sessões.
- Servidor `http.createServer` na fixture → o painel abre na porta.
- `printf '\e]52;c;?\a'` não devolve o clipboard.
- Um link `javascript:` não abre.

**Manual, com checklist em `docs/manual-check.md` no M5:**
- Mods do Claude no claro e no escuro, redimensionando durante a animação.
- Shift+Enter.
- Acentos.
- Repouso do Mac → sessões interrompidas.
- Bloqueio de tela → sessões continuam.
- Notificação com o app em segundo plano.
- Abrir o app pelo Finder (PATH quase vazio) e confirmar que acha `claude` e `codex`.

---

## 17. Decisões que dependem de você
1. **Nome do app:** não pode ser "Terminal".
2. **OSC 52 de escrita:** permitir (para copiar no Claude fullscreen) ou bloquear como o Hermes. Depende do teste do M0.
3. **Camada C:** só se o M0 mostrar que é necessária. É a única etapa que mexeria em `~/.claude`, e só com o seu clique.
4. **Desligar os avisos do claude-notifier,** com consentimento.

---
TOPICO: Plano do app de terminal e perdas do Cursor
RESUMO: Montei o plano do app (Electron + node-pty + xterm.js), com arquitetura, dados, status em camadas (OSC 7501, hooks, heurística), navegador, árvore com prévia, mods isolados e marcos M0 a M5 com critérios de aceite. Sair do Cursor muda basicamente o aplicativo. As perdas reais são pequenas: visualizar arquivos, Shift+Enter, som ao terminar e o clique dos avisos. O plano cobre todas, e o Cursor fica instalado para quando você quiser editar código. Os mods ficam feios por configuração do xterm.js, não pelo app; o plano corrige isso.
PROXIMO PASSO: Escolher o nome do app e rodar o M0, que testa OSC 7501, `--settings` somando hooks, XTVERSION, OSC 52, os mods com WebGL e Shift+Enter.
---