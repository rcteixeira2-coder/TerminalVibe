# Port spec: terminal do Hermes para Terminal.app (Electron, node-pty, xterm.js)

Pesquisa só de leitura: nenhum arquivo foi criado ou alterado. Todas as citações são relativas a `/Users/rodrigoteixeira/Desktop/Hermes`.

## 0. Resposta ao pedido: o que se perde ao deixar o Cursor

**Resposta curta: quase tudo que importa continua igual; muda basicamente o aplicativo.** Claude Code, skills, hooks, mods, plugins, MCPs, histórico, `--resume`, `/rewind` e `settings.json` ficam em `~/.claude` e no CLI. Nada disso depende do Cursor.

Medi o uso real no seu Mac:
- **Sessões do Claude (30 dias):** 159 no total. 151 foram `entrypoint:"cli"` e 8 `sdk-cli`. Nenhuma foi pelo painel da extensão, mesmo com `"claudeCode.preferredLocation": "panel"` configurado.
- **Integração Claude Code ↔ Cursor (ponte `/ide`):** zero sessões com arquivo aberto, seleção ou diagnósticos enviados ao Claude. A ponte existe (`~/.claude/ide/26636.lock`, `ideName:"Cursor"`, via websocket), mas não é usada.
- **Editor do Cursor:** no histórico de edições dos últimos 30 dias só aparecem `settings.json` e um arquivo de workspace. Você não edita código no Cursor.
- **IA do próprio Cursor:** `~/.cursor/ai-tracking/ai-code-tracking.db` não muda desde 16/jun. Extensões instaladas: só `anthropic.claude-code`, `remote-ssh` e `remote-containers`.

**O que se perde de fato (conveniências, pouco usadas hoje):**
- Abrir arquivo na linha exata ao clicar num caminho no terminal.
- Editor de código.
- Ver o diff das mudanças do Claude, painel de Git e busca global.
- Preview de Markdown.
- Remote SSH e Containers.
- Cursor Tab e Agent.
- Diagnósticos do editor enviados ao Claude: sem eles, o Claude roda `tsc`/`eslint` por conta própria.
- **Saída simples para tudo isso:** manter o Cursor instalado e pôr um botão ou item de menu "Abrir no Cursor" (`open -a Cursor <pasta>`, ação explícita do usuário).

**O que precisa ser portado do seu Cursor:**
- **Shift+Enter:** `~/Library/Application Support/Cursor/User/keybindings.json` envia `"\u001b\r"` quando o terminal está em foco. No xterm.js: `attachCustomKeyEventHandler` com `pty.write('\x1b\r')`.
- **Sensibilidade da roda do mouse** igual a 3 (`settings.json`). No xterm.js: `scrollSensitivity: 3`.
- **Hooks de aviso:** `~/.claude/hooks/_lib/click.js:24,29` ativa o "Visual Studio Code" ao clicar no aviso, e `extensionOwnsCwd` supõe uma extensão de editor. Os dois precisam passar a apontar para o app novo, ou serão substituídos pelo socket de hooks dele.

**Alerta importante para o plano:** o terminal integrado do Cursor **já é xterm.js**. Trocar de app não corrige os mods sozinho; o que corrige é a configuração. No seu Cursor está `terminal.integrated.gpuAcceleration: "off"`, o que liga o renderizador DOM. Esse renderizador desenha faixas e caracteres de bloco com a fonte, o que costuma deixar falhas. O VS Code também usa `minimumContrastRatio` 4.5, que altera as cores. Isso é provável, não confirmado.

Recomendação para o app novo:
- `@xterm/addon-webgl`, com fallback para o renderizador DOM.
- `@xterm/addon-unicode11` com `activeVersion = '11'`.
- `customGlyphs: true`, `minimumContrastRatio: 1`, `lineHeight: 1`, `rescaleOverlappingGlyphs: true`.
- Cores truecolor.

## 1. Comportamentos visíveis para o usuário

### Iniciar sessões: Claude, Codex e shell

**Três tipos de sessão.** `DevAgent` tem claude, codex e terminal (`Sources/DevProtocol/DevProtocol.swift:3-9`).

**Executável.** O shell é sempre `/bin/zsh`. Claude e Codex são procurados nas pastas do PATH montado, sem passar por um shell (`DevProtocol.swift:139-146`).
- Electron: percorrer `env.PATH` com `fs.accessSync(p, X_OK)` e chamar `pty.spawn(absPath, args, …)`, nunca `zsh -c`.

**Argumentos** (`DevProtocol.swift:148-154`):
- shell: `["-il"]`
- Claude: `[]`, e `["--resume"]` para retomar
- Codex: `[]`, e `["resume"]` para retomar
- Nunca usa flags que pulam permissões (teste em `Tests/Dev/main.swift:72`). Manter igual.

**Início** (`Sources/HermesDevHost/Workspace.swift:45-71`):
- O diretório de trabalho é a pasta do projeto, verificada com `canonicalDirectory` (`DevProtocol.swift:162-167`, equivalente a `fs.realpathSync` mais `isDirectory`).
- Erros: "Não encontrei X neste Mac…" (`Workspace.swift:49`) e "A pasta do projeto foi movida ou apagada." (`Workspace.swift:53`).
- Cada início cria um terminal novo, com a tela limpa (`Workspace.swift:57-58`). No xterm: `term.dispose()` e um `new Terminal()`.

**Estados** (`DevProtocol.swift:11-13`): idle, running, stopping, exited, interrupted, failed.
- No cabeçalho: bolinha verde quando está rodando, mais a mensagem (`Workspace.swift:331-333`).
- Electron: mesmo enum, emitido do main para o renderer por IPC. Os estados de hooks (trabalhando / sua vez / aprovação / erro) são uma camada à parte.

**Botão por tipo na barra.** O tipo escolhido fica em negrito (`Workspace.swift:371-377`).
- Há uma sessão principal por tipo (`sessions[DevAgent]`, `Workspace.swift:161,186-193`). Trocar de tipo não mata as outras sessões.
- Escolher um tipo inicia a sessão automaticamente se ela estiver idle (`Workspace.swift:192`).

**Tela vazia** "Escolha como trabalhar neste projeto", com os botões Abrir Claude, Codex e Terminal (`Workspace.swift:415-426`).

**Última escolha por projeto.**
- Guardada no app principal (`lastAgents`, `Sources/Hermes/DevWorkspace.swift:32-39,89-93`) e enviada no open (`DevWorkspace.swift:111`).
- Restaurada sem iniciar sozinha quando a sessão foi interrompida (`Workspace.swift:184`).
- Electron: `electron-store` ou JSON em `app.getPath('userData')`, com chave = caminho canônico.

### Painéis divididos, até 4

**Regras.** `maxPanes = 4` e `canSplit` (`Workspace.swift:164,194`).
- O botão de dividir abre um terminal shell. A seta escolhe Terminal, Claude ou Codex (`Workspace.swift:378-389`).
- O botão fica desabilitado no limite, com a dica "Até 4 terminais".

**Painel extra** (`Workspace.swift:224-233`):
- Inicia na hora e recebe o foco (`Workspace.swift:231`).
- Tem um X que encerra a sessão imediatamente (`Workspace.swift:264-268,344-347`).
- Títulos numerados quando há repetição, por exemplo "Claude 2" (`Workspace.swift:270-274`).

**Layout:** HSplitView horizontal, largura mínima de 260 por painel (`Workspace.swift:398-404`).
- Electron: CSS grid/flex com divisórias arrastáveis, ou `allotment`/`split.js`.
- A grade de sessões entre projetos é algo novo, que o Hermes não tem.

### Interromper, encerrar, retomar, nova sessão

**Botões** (`Workspace.swift:335-343`):
- Rodando: "Interromper" e "Encerrar sessão".
- Parada: "Retomar conversa" (só Claude e Codex) e "Nova sessão".

**Interromper** envia o byte `0x03` ao PTY (`Workspace.swift:73-76`). Electron: `pty.write('\x03')`.

**Encerrar** (`Workspace.swift:78-85`) usa a limpeza da árvore de processos descrita abaixo, depois `terminate()`. O estado vira stopping e a mensagem "Encerrando sessão…".

**Retomar** abre o seletor nativo do agente (`README.md:325`).

### Limpeza da árvore de processos

**Identidade do processo:** PID mais horário de início, para nunca mandar sinal a um PID reaproveitado (`Sources/DevProtocol/DevProcessTree.swift:4-16`).

**Descendentes:** `proc_listallpids` e PPID montam a árvore (`DevProcessTree.swift:25-41`). Ela é capturada a cada 0,4 s enquanto a sessão roda (`Workspace.swift:66-69,104-111`).

**Encerramento** (`DevProcessTree.swift:43-57`):
1. Congela tudo com SIGSTOP.
2. Coleta de novo os descendentes.
3. Envia SIGTERM, depois SIGCONT.
4. Envia SIGKILL 0,6 s depois.

**Quando o processo principal termina**, os órfãos são mortos na hora (`Workspace.swift:122-130`).

Electron:
- Árvore: `ps -axo pid=,ppid=,lstart=` a cada 0,4 s, ou o módulo `pidtree`, guardando PID mais horário de início.
- Encerramento: mesma sequência com `process.kill(pid, 'SIGSTOP'|'SIGTERM'|'SIGCONT'|'SIGKILL')`, conferindo a identidade antes de cada sinal.
- Não confiar só em `pty.kill()`, que atinge apenas o líder do grupo de processos.

### Impedir repouso enquanto há sessão rodando

- **Hermes:** `KeepAwake` mantém `PreventUserIdleSystemSleep` enquanto houver pelo menos uma sessão rodando. A tela ainda apaga e bloqueia (`Workspace.swift:137-154`); a atualização acontece em `Workspace.swift:116`.
- **Electron:** `powerSaveBlocker.start('prevent-app-suspension')` com contagem de sessões; `stop(id)` quando a contagem chega a zero.

### Regras de sobrevivência das sessões

| Evento | Hermes | Electron |
|---|---|---|
| Fechar a janela | Só esconde; PTYs continuam (`Sources/HermesDevHost/main.swift:144-149`); o app não sai (`main.swift:149`) | `win.on('close', e => { e.preventDefault(); win.hide() })`; app continua no Dock |
| Tela bloqueada / monitor apagado | Sessões continuam, janela escondida (`main.swift:42-52`, `README.md:325`) | `powerMonitor.on('lock-screen')`: esconder é opcional; sessões continuam |
| Repouso do Mac / troca de usuário | Encerra tudo (`main.swift:36-41`) | `powerMonitor.on('suspend')` e `on('user-did-resign-active')` chamam `stopAll` e marcam interrupted |
| Sair do app / SIGTERM, SIGINT, SIGHUP | `stopAll` (`main.swift:30-35,150-153,164-171`) | `app.on('before-quit')` e `process.on('SIGTERM')` chamam `stopAll` |
| Reinício do app | Projetos abertos reabrem como interrupted, oferecendo "Retomar conversa" (`Sources/Hermes/DevWorkspace.swift:141-155`, mensagem em `Workspace.swift:29`) | Salvar as sessões abertas no `before-quit`; na abertura, mostrar "Retomar" |
| Pedidos | Nunca são reenviados sozinhos (`README.md:325`) | Manter |

### Árvore de arquivos, só leitura

**Listagem** (`Sources/DevTerminal/ProjectFiles.swift:13-37`):
- Um nível por vez, até 2000 itens por pasta, com a linha "… mais N itens" (`Sources/HermesDevHost/FileTree.swift:92-95`).
- Pastas primeiro, ordem natural.
- Arquivos ocultos aparecem em cinza (`FileTree.swift:112`).
- Pacotes como `.app` contam como arquivo (`ProjectFiles.swift:30`).

**Segurança da listagem:**
- Links simbólicos aparecem com ícone próprio, mas nunca são seguidos (`ProjectFiles.swift:29-31`, `FileTree.swift:140`).
- `isInside` recusa caminhos que saem da pasta via `..` ou via link simbólico em qualquer nível (`ProjectFiles.swift:39-57`, testes em `Tests/Dev/main.swift:152-160`).

**Interação** (`FileTree.swift:22-52,119-126`):
- Carregamento preguiçoso fora da thread principal.
- Botões Atualizar e Recolher tudo.
- Clique simples abre ou fecha a pasta. Duplo clique abre a pré-visualização do arquivo.
- Mostrar/esconder a árvore fica salvo (`devFileTree`, `Workspace.swift:358,362-364`). Largura de 180 a 300 (`FileTree.swift:78`).

**Ícones por extensão:** `FileTree.swift:139-149`.

**Electron:**
- No main: `fs.promises.readdir(dir, {withFileTypes:true})`, `fs.lstat` para links, e `realpath` mais checagem de prefixo em cada nível.
- O renderer só recebe dados por IPC; nunca dar `fs` ao renderer.
- Ordenação: `Intl.Collator('pt-BR', {numeric:true})`.

**Quick Look** (`FileTree.swift:80`, `.quickLookPreview`):
- Electron: `BrowserWindow.previewFile(path)` é Quick Look nativo do macOS.
- Nunca usar `shell.openPath` em arquivos: o Hermes nunca abre nem executa arquivos (`README.md:327`).

**Menu de contexto** (`FileTree.swift:127-137`):
- "Pré-visualizar": só para arquivos.
- "Ver no navegador": só para HTML.
- "Mostrar no Finder": `shell.showItemInFolder`.
- "Copiar caminho": `clipboard.writeText`.
- "Inserir caminho no terminal".
- Electron: `Menu.buildFromTemplate` disparado por IPC.

**Inserir caminho no último terminal usado:**
- O caminho vai entre aspas simples, `'` vira `'\''`, sem Enter, seguido de um espaço (`ProjectFiles.swift:59-62`, `Workspace.swift:285-292`).
- Destino: o último terminal que teve foco (`Workspace.swift:276-283`); senão, o principal. Se não houver processo rodando, toca um beep.
- Electron: guardar `lastFocusedSessionId` (evento de foco da textarea do xterm) e chamar `pty.write(quoted + ' ')`.

### Teclado, menus e janela

**Atalhos de edição do Mac** (`Sources/DevTerminal/SafeTerminalView.swift:100-137`):

| Tecla | Bytes | Ação |
|---|---|---|
| ⌥⌫ | ESC DEL | apaga a palavra anterior |
| ⌘⌫ | `^U` | apaga até o início da linha |
| ⌥⌦ | ESC d | apaga a próxima palavra |
| ⌥← / ⌥→ | ESC b / ESC f | palavra anterior / próxima |
| ⌘← / ⌘→ | `^A` / `^E` | início / fim da linha |

- Nada é capturado enquanto há texto em composição (acentos).
- `optionAsMetaKey = false` para preservar os acentos do português (`SafeTerminalView.swift:51`).
- Electron: `macOptionIsMeta: false` e `attachCustomKeyEventHandler`, respeitando `e.isComposing`. Somar o Shift+Enter do Cursor.

**Menus** (`main.swift:172-191`): ⌘Q, Copiar/Colar/Selecionar tudo, ⌘W fecha a janela (sem matar sessões), ⌘M.
- Electron: `Menu.setApplicationMenu` com `role: 'copy' | 'paste' | 'selectAll'`. No xterm, copiar a seleção explicitamente com `term.getSelection()`.

**Aparência e foco:**
- Fonte monoespaçada do sistema, tamanho 13; cores do sistema; segue o modo claro/escuro (`SafeTerminalView.swift:48-50`).
- Electron: `fontFamily: 'SF Mono, Menlo'`, tema ligado a `nativeTheme`.
- Histórico de 10 000 linhas (`SafeTerminalView.swift:43-44`): `scrollback: 10000`.
- GPU: Metal com fallback (`SafeTerminalView.swift:54-59`). Equivale ao addon WebGL, com fallback em `onContextLoss`.
- Correção de foco no clique (`SafeTerminalView.swift:71-76`): no xterm, `term.focus()` no mousedown.
- Título da janela fixo: `"<projeto> · Hermes Projetos"`. Títulos e cwd vindos do terminal são ignorados (`main.swift:119`, `SafeTerminalView.swift:87-88`).
- Electron: não aplicar `onTitleChange` à janela; pode exibir só como rótulo secundário.

**Janela:** mínimo de 700×420 (`main.swift:120`).

### Iniciar app: dev server, app Mac ou HTML

**Varredura** (`Sources/DevTerminal/LaunchTargets.swift:24-58`):
- Procura `.app`, `package.json` com script `dev` ou `start` e arquivos `.html`.
- Até 2 níveis de profundidade. Ignora pastas ocultas, `node_modules`, `.git`, `.build`, `.next`, `.cache`, `__pycache__`, `win-unpacked` e `linux-unpacked`.
- Ordem: apps, depois servidores, depois páginas.

**Gerenciador de pacotes:** pelo arquivo de lock: pnpm, yarn, bun, senão npm. Faz `install` antes quando não existe `node_modules` (`LaunchTargets.swift:60-70`).
- O comando é montado só com palavras fixas mais a pasta entre aspas (`LaunchTargets.swift:16-21`).

**Execução:**
- Servidor: abre um novo painel de terminal e digita o comando seguido de `\n` (`Workspace.swift:247-262`).
- App Mac: abre no macOS.
- HTML: abre no navegador embutido.
- A escolha fica salva por projeto (`devLaunchTarget:`).
- Botão play com menu por seção (`Workspace.swift:430-472`).

**Electron:** mesma lógica no main. O servidor roda num pty novo. Somar a detecção de `localhost:PORT` na saída para abrir o navegador lateral (meta 4).

### Navegador e pré-visualização ao vivo de HTML

**Hermes** (`Sources/HermesDevHost/Preview.swift:8-131`):
- Carrega arquivo local com leitura limitada à pasta do projeto, em `websiteDataStore = .nonPersistent()`.
- Vigia a pasta com FSEvents e recarrega 0,8 s depois da última mudança. Ignora `.git`, `node_modules`, `.DS_Store`, `~`, `.swp`, `.tmp` e `.#` (`Sources/DevTerminal/PreviewFiles.swift:40-51`).
- Mantém a posição de rolagem ao recarregar (`Preview.swift:59-68,80-84`).
- Página preferida: a lembrada, senão `index.html` na raiz, senão a única, senão a mais recente (`PreviewFiles.swift:28-38`).
- Visibilidade lembrada (`devPreviewHidden`).

**Navegação** (`Preview.swift:133-147`): só arquivos do projeto e `about:` ficam no painel. Link clicado ou arquivo fora da pasta vai para o navegador padrão.

**Electron:**
- `WebContentsView` com uma partição sem prefixo `persist:` (memória apenas).
- `webContents.on('will-navigate')` e `setWindowOpenHandler(() => ({action:'deny'}))`, mais `shell.openExternal` apenas para http/https.
- `fs.watch(root, {recursive:true})`, que no macOS usa FSEvents, com debounce de 800 ms.
- Para localhost: liberar só `http://localhost:*` e `127.0.0.1`.

### Lista de projetos

- **Origem:** pastas da Mesa (ignorando ocultas e pacotes) mais pastas adicionadas que ainda existem, ordenadas pelo nome (`Sources/Hermes/Dev.swift:37-55`).
- **Adicionar:** seletor de pasta começando na Mesa (`Sources/Hermes/DevViews.swift:95-108`). Electron: `dialog.showOpenDialog({properties:['openDirectory'], defaultPath})`.
- **Remover:** só as adicionadas. "Mostrar no Finder" para todas (`DevViews.swift:51-58`).
- **Favoritos e status por sessão:** novos, não existem no Hermes.

### Status por leitura do transcript: referência para um fallback

- `DevSessionReader.status` (`Sources/Hermes/DevSession.swift:196-204`):
  - ferramenta sem resultado por mais de 3 s: "esperando" (provável permissão)
  - última fala do assistente: idle
  - menos de 60 s desde a última atividade: trabalhando
- Nome da pasta em `~/.claude/projects`: todo caractere que não seja `[A-Za-z0-9]` vira `-` (`DevSession.swift:129-132`).
- Textos de aviso por tipo, `ExitPlanMode` ("Plano pronto"), `AskUserQuestion` ("pergunta") e permissão: `Sources/Hermes/DevRemote.swift:70-89`. Servem para as notificações do macOS (`new Notification()` no main).
- **Recomendação:** os hooks são a fonte principal; o transcript é só fallback. Ver a seção 2: o Hermes não grava transcrições próprias, só lê as do Claude.

## 2. Regras de segurança

| Regra | Hermes | Electron / xterm.js |
|---|---|---|
| OSC 52 (clipboard) bloqueado, leitura e escrita | `SafeTerminalView.swift:91-92`; teste em `Tests/Dev/main.swift:79-84` | Não carregar `@xterm/addon-clipboard`; `term.parser.registerOscHandler(52, () => true)` para engolir |
| Kitty clipboard bloqueado | `SafeTerminalView.swift:29,93-94` | Mesmo handler (o xterm.js não implementa) |
| Imagens Kitty e Sixel desligadas | `SafeTerminalView.swift:30-31`, `README.md:337` | Não carregar `@xterm/addon-image` |
| Tamanho máximo de OSC: 64 KB | `SafeTerminalView.swift:27` | Handlers OSC próprios descartam payloads acima de 64 KB |
| Links: só http/https, com host, sem usuário/senha, só com clique | `DevProtocol.swift:111-119`, `SafeTerminalView.swift:95-97`; testes em `Tests/Dev/main.swift:73-76` (bloqueia `file:`, `javascript:`, `hermes:`, `vscode:`, caminhos, credenciais) | `linkHandler: {activate}` para OSC 8 mais `WebLinksAddon(handler)`; validar com `new URL()`; `shell.openExternal` só no main |
| Título nunca volta como entrada (CVE-2022-23465) | `Tests/Dev/main.swift:88-89` | Manter `windowOptions` padrão (tudo false); nunca ligar `getWinTitle` nem `pushTitle` |
| Título e cwd do terminal ignorados | `SafeTerminalView.swift:87-88` | Ver acima |
| Ambiente mínimo | `DevProtocol.swift:121-137`; testes em `Tests/Dev/main.swift:66-69` | Detalhe abaixo |
| Pipes e descritores privados não vazam para o shell | `main.swift:21-25`; teste em `Tests/Dev/main.swift:106-111` | Testar no node-pty se descritores do Electron vazam (`ls /dev/fd` dentro do pty) |
| Sem transcrições gravadas | `setHostLogging(directory: nil)` em `SafeTerminalView.swift:52`, `README.md:337` | Não persistir buffer nem logs do pty; a saída só é guardada em memória para o botão "copiar", nunca no disco |
| Caminho inserido como dado | `ProjectFiles.swift:59-62`; testes em `Tests/Dev/main.swift:161-162` | Mesma função de aspas |
| Árvore e pré-visualização confinadas à pasta | `ProjectFiles.swift:39-57`, `Preview.swift:50` | `realpath` mais checagem de prefixo no main |
| Arquivos nunca abertos nem executados | `README.md:327` | Só Quick Look e Finder |
| Navegador sem dados persistidos | `Preview.swift:27` | Partição em memória |
| Sem flags que pulam permissões | `README.md:333` | Manter |

**Ambiente mínimo, em detalhe:**
- Hermes copia só USER, LOGNAME, LANG, LC_CTYPE e TMPDIR.
- PATH fixo: `~/.local/bin`, `~/.local/opt/node/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`, `/usr/sbin`, `/sbin`, mais o PATH herdado, mas só caminhos absolutos (nunca `.`).
- `HOME`, `SHELL=/bin/zsh`, `LANG=pt_BR.UTF-8` por padrão, `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=Hermes`.
- Ficam fora: tokens, chaves de API, `DYLD_*` e `NODE_OPTIONS`.
- Electron: montar a partir de uma lista branca, nunca `{...process.env}`. Isso exclui também `ELECTRON_*` e `NODE_OPTIONS`.
- O PATH fixo é ainda mais importante quando o app é aberto pelo Finder, porque o PATH herdado vem quase vazio.
- Definir `TERM_PROGRAM` com o nome do app.

**Ponto de atenção do Electron:** usar `contextIsolation: true`, `sandbox: true` e `nodeIntegration: false` no renderer. Os ptys vivem só no main (ou num utilityProcess), e o renderer só envia e recebe bytes por um IPC com tipos definidos.

## 3. Acoplamento exclusivo do Hermes, a remover

- **Processo auxiliar e protocolo de pipes:**
  - `DevHostCommand`, `DevHostEvent`, `DevLineFramer` e versão 2 (`DevProtocol.swift:15-109`)
  - `HostControlReader` (`main.swift:194-222`)
  - `DevHostConnection` e `DevHostEventReader` (`Sources/Hermes/DevWorkspace.swift:167-266`)
  - guarda de execução `--managed` e `isatty` (`main.swift:224-228`)
  - caminho do auxiliar dentro do bundle (`DevWorkspace.swift:56-59`)
- **Touch ID e SessionAccess (leases):** `DevWorkspace.swift:45,62,74,110,123-124` e `DevSession.swift:207`.
- **Janelas em cascata e geometria pelo app principal:** `WindowCascade` (`DevWorkspace.swift:75-87,99-101,160`), `main.swift:73-94,133-143`, nível flutuante e todos os Spaces (`main.swift:125-126`).
- **Mascote e presença:** evento `activity` de interação (`main.swift:53-60`, `README.md:18`) e `.accessory` sem ícone no Dock (`main.swift:231`). O app novo deve ser `.regular`.
- **Remote Control pelo celular, Telegram e chaRT:**
  - `startRemote`, `type`, `finishRemote`, `scanRemote`, `recordsOutput` e `startedByHermes` (`Workspace.swift:19-43,87-102,196-222,294-302`; `SafeTerminalView.swift:34-42`)
  - `remoteArguments` e o enum `DevRemote` (`DevProtocol.swift:156-160,171-204`)
  - `DevRemoteWatcher` para o Telegram (`Sources/Hermes/DevRemote.swift`)
  - todos os arquivos `DevRequest*`, que formam o pipeline de pedidos de colegas e não pertencem ao terminal
- **Comando de voz "abre o projeto X":** `Dev.swift:15-35`.
- **Esconder a janela na tela bloqueada e exigir "Abrir janela" pelo Hermes** (`main.swift:42-49`): no app novo é opcional.
- **SwiftTerm de terceiros com verificação de hash:** `Vendor/SwiftTerm`, `README.md:335`. Vira dependências npm com versão fixa e lockfile.

---
TOPICO: Spec de porte do terminal Hermes e Cursor
RESUMO: Mapeei comportamentos, regras de segurança e acoplamentos do terminal do Hermes, com arquivo:linha e o equivalente em Electron/node-pty/xterm.js. Pelo uso medido, sair do Cursor muda praticamente só o aplicativo: todas as sessões são CLI, a ponte /ide não é usada e o editor quase não é usado. O Cursor já usa xterm.js, então a qualidade dos mods depende da configuração (WebGL, Unicode 11, contraste 1, glifos próprios), não da troca de app.
PROXIMO PASSO: Incorporar ao plano o Shift+Enter, scrollSensitivity 3, o botão "Abrir no Cursor" e a adaptação dos hooks de aviso para o app novo.
---