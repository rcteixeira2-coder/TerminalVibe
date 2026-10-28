# Cockpit

Terminal visual para quem trabalha com várias sessões de **Claude Code**, **Codex** e shell ao mesmo tempo, em vários projetos. Electron + node-pty + xterm.js, portado do terminal do Hermes.

- **Barra lateral de projetos**: Favoritos, Em uso, Mesa (pastas do Desktop) e Adicionadas, cada uma com cor própria e o estado de cada sessão.
- **Status por sessão**: trabalhando · precisa de aprovação · sua vez · terminou · erro. Vem do próprio Claude e do Codex (OSC 7501) e de hooks por sessão no Claude; outros programas usam OSC 9/BEL/heurística (marcado com `·~`).
- **Painéis em cartões**: cada sessão num cartão sobre uma calha escura. Quando precisa de você (sua vez, aprovação, erro), o cabeçalho fica na cor do estado, ganha moldura e o botão **Responder ↵**; "Terminou" fica verde ("revisar"), "Trabalhando" mostra uma linha azul andando. A tarefa aparece em destaque; Interromper/Encerrar/✳ Mods só no hover ou no painel em foco. A linha de estado tem altura fixa: trocar de estado nunca redimensiona o terminal.
- **Abas coloridas** por projeto, até 6 painéis por aba, **layouts** no botão ▦ (lado a lado, terços, 2/3 + 1/3, 1 grande + empilhados, quadrantes, grade 3×2): arraste o terminal pelo cabeçalho para trocar de lugar, ⤢ (⌘⇧↩) expande um painel para a aba toda, **+ App** mostra o site do projeto num espaço, e as divisórias (duplo clique volta à proporção) ficam salvas por projeto; **grade** com todas as sessões (⌘G) e **notificações** do macOS só quando você não está olhando a sessão.
- **Browser lateral**: abre sozinho quando um dev server imprime `http://localhost:PORTA`; HTML local recarrega ao salvar mantendo a rolagem.
- **▶ Rodar abre sempre no Cockpit**: a página ou o servidor escolhido aparece no painel (ou no espaço App do layout). Rodar de novo um servidor que já está rodando não sobe outro: mostra o endereço dele.
- **O Claude usa o navegador do Cockpit**: cada sessão do Claude aberta aqui recebe ferramentas `browser_*` (MCP `cockpit_browser`, já liberadas) para abrir o app do projeto, tirar print, ler a página, clicar, digitar, ver console e requisições com erro e rodar JavaScript — sem mexer no seu Chrome. O painel aparece com o selo "🤖 <sessão>"; se o projeto não está na tela, a página é desenhada fora da vista, sem trocar de projeto. Só localhost e arquivos do projeto.
- **Árvore de arquivos** (só leitura) com prévia de imagem/vídeo/áudio/texto, Quick Look, "Inserir caminho no terminal" e "Abrir no Cursor".
- **Mods do Cockpit**: botões, comandos ⌘K, painéis e reações aos eventos das sessões.
- Os **mods do Claude Code** (`~/.claude/mods`) aparecem corretamente: WebGL + glifos desenhados, contraste mínimo 1, Unicode 11, DEC 2026.

## GitHub por projeto

Cada projeto mostra o ícone do GitHub na barra lateral e no cabeçalho: **↓N** (o GitHub tem commits que não estão aqui), **↑N** (commits para subir), **●N** (arquivos alterados), **↑ novo** (branch não publicada). O Cockpit faz `git fetch` a cada 5 min e relê o status local no foco e quando um agente termina. Clique no ícone para ver os commits e usar **Baixar** (`git pull --ff-only` num terminal), **Subir** (`git push`) ou **Pedir ao Claude** (`/UploadNoGithub`). Nada é baixado ou enviado sem o seu clique. Pastas sem git mostram o ícone apagado com **Conectar ao GitHub**.

## Uso dos modelos (📊, ⌘⇧U)

Botão **📊 Uso** no rodapé da barra lateral (a barrinha é a sessão de 5 h do Claude). O painel tem três abas:

- **Planos:** limites do Claude (sessão de 5 h e semana) e do Codex/ChatGPT (janelas e créditos), com "renova em". Os do Claude vêm de um módulo no plugin do Cockpit (`resources/claude-plugin/hooks/usage.ts`), que lê `$.session.usage()` dentro de cada Claude aberto pelo Cockpit; os do Codex, de `~/.codex/sessions`.
- **Sessões:** tokens do Claude Code (`~/.claude/projects`) e do Codex por dia, modelo e projeto, com o **equivalente em API** (estimativa; modelos sem preço público aparecem como "—"). Leitura incremental num worker; só números, nunca o texto das conversas.
- **API:** o que o agente do Cockpit gastou por provedor e, com **chaves Admin** (Preferências → Uso da conta inteira), o custo real da conta na Anthropic e na OpenAI. Essa aba só lê o Keychain depois de um clique.

O plugin é copiado para a pasta de dados do Cockpit ao abrir (o Claude grava arquivos de tipos dentro dele; o app assinado fica intacto).

## Agente (✦, ⌘L)

Painel de conversa no dock direito (abas **Agente | Browser**), como o "New Agent" do Cursor, **só leitura**: ele lista pastas, lê e busca arquivos do projeto e vê a saída recente dos terminais — nunca edita nem roda comandos. Responde em streaming, mostra o que leu ("📄 leu `src/x.ts` (linhas 1–200)") e cita caminhos clicáveis que abrem a prévia.

- **Modelos:** **Claude (assinatura)** — usa o Claude Code logado neste Mac (Pro/Max), sem chave de API: roda `claude -p` sem as ferramentas próprias dele e sem seus hooks/plugins/CLAUDE.md, enxergando só as ferramentas do Cockpit (servidas por um MCP local em 127.0.0.1 com token por resposta). Também Grok (xAI), Claude (API da Anthropic), OpenAI e locais (Ollama, LM Studio). Troque no seletor do topo — dá para mudar de modelo no meio da conversa.
- **Chaves:** em **Preferências → Agente** (colar → Salvar → Testar). Ficam criptografadas no Keychain do Mac e nunca voltam para a tela.
- **Keychain:** só o Agente e o Robô usam o item "Cockpit Safe Storage" (chaves e histórico), e só quando você os abre ou clica **Mostrar chaves** — abrir o app para usar o terminal não pede senha. Negar não afeta os terminais. Como o app é assinado ad hoc, o macOS pergunta de novo depois de cada `install:mac`.
- **Contexto:** `@arquivo` anexa um arquivo; `›_ terminal` anexa a saída recente do terminal focado.
- **Ações:** Copiar e **Enviar para a sessão** (cola a resposta no Claude/Codex focado, sem enviar — você revisa).
- **Histórico:** conversas por projeto, criptografadas em disco; lista "Anteriores" no topo do painel.
- **Segredos nunca são lidos** pelo agente: `.env*`, chaves (`*.pem`, `*.key`, `id_*`), `.git/`, `.ssh`.

## Robô das sessões: no Hermes

O assistente de todas as sessões é o **Hermes** (`~/Desktop/Hermes`). O Cockpit só serve de mãos pelo canal de controle (`run/control.sock`, ver o README do Hermes):

- **Avisa:** quando um Claude ou Codex para esperando você (aprovação, sua vez, erro) por alguns segundos, o Cockpit manda `attention` ao Hermes. O balão do mascote mostra a sessão com **Responder** e **Abrir no Cockpit**. A saída desse estado manda `attentionCleared`.
- **Lê:** `sessions` (sessões vivas, com quem precisa de você) e `tail` (fim da tela, com segredos mascarados).
- **Responde:** `send` cola o texto na sessão e dá Enter separado. Uma letra ou dígito sozinho vai como tecla, para escolher a opção de um menu. Nada é enviado sem você confirmar o cartão no chat do Hermes.
- **Foca:** `focus` traz o Cockpit para a frente na sessão.
- **Pedidos novos** continuam no `request`, que abre o Claude em modo plano, na pasta certa, com Remote Control.

## Rodar

```sh
npm install          # baixa o Electron e marca o spawn-helper do node-pty como executável
npm run dev          # desenvolvimento com recarga
npm test             # testes unitários (vitest)
npm run install:mac  # gera o app (fora da Mesa, por causa do iCloud) e instala em ~/Applications/Cockpit.app
```

Testes de ponta a ponta (abrem o app real com dados isolados, Playwright):

```sh
npm run build
node tests/e2e/flow.mjs /tmp      # terminal, ambiente limpo, descritores, divisão, grade
node tests/e2e/browser.mjs /tmp   # ▶ Rodar → browser abre sozinho, árvore, prévia, paleta
node tests/e2e/claude.mjs /tmp    # Claude real: transições de status (envia um prompt curto)
node tests/e2e/keyboard.mjs       # teclado Mac, links de caminho, arrastar arquivo, busca, Esc na prévia
node tests/e2e/processes.mjs      # árvore de processos, quit sem órfãos, saída enorme, recarga da interface
node tests/e2e/resume.mjs         # retomar a mesma conversa (painel e após reabrir), reinício em aba cheia
node tests/e2e/status.mjs         # Codex real, notificação + clique, grade, claude dentro do shell
node tests/e2e/mods-security.mjs  # mod travado isolado, mods sem rede/sem permissão
node tests/e2e/preview-net.mjs    # HTML local sem internet e sem .env
node tests/e2e/quit-crash.mjs     # regressão: sair com sessões ativas não gera erro
node tests/e2e/close-fullscreen.mjs # regressão: fechar em tela cheia não deixa a tela preta e reabre em tela cheia
node tests/e2e/agent.mjs          # agente com provedor falso: chave, ferramenta, prévia, enviar p/ sessão, histórico
node tests/e2e/hermes-sessions.mjs # canal do Hermes: sessions, tail mascarado, send, focus e o aviso attention
node tests/e2e/browser-agent.mjs  # ▶ Rodar sempre no Cockpit (sem servidor duplicado) e o Claude usando o navegador pelo MCP
node tests/e2e/pane-states.mjs    # cartões por estado: cores, contraste ≥4,5 nos 2 temas, painel estreito, terminal sem refit
node tests/e2e/launch-openin.mjs  # ▶ Rodar → "Abrir em Navegador" abre o servidor fora do Cockpit
node tests/e2e/git.mjs            # ícone do GitHub: ↓ ↑ ● com remote local, painel, Baixar, pasta sem git
node tests/e2e/layout.mjs         # menu ▦: layout, espaço livre, arrastar terminal, divisória lembrada ao reabrir
node tests/e2e/layout-app.mjs     # "+ App" num espaço (site do ▶ Rodar), ⤢ expandir, divisória arrastada e duplo clique
node tests/e2e/usage.mjs          # painel 📊: HOME falso, limites pelo canal do plugin, Admin APIs falsas, sem vazar chave/conversa
node tests/e2e/usage-real.mjs     # real: 1 mensagem curta ao Claude → limites do plano chegam; totais dos registros
node tests/e2e/claude-mods-pane.mjs # ✳ Mods na sessão do Claude: liga mod (HOME falso) e reinicia retomando a conversa
```

O checklist completo, com a evidência de cada item e os bugs encontrados, está em `docs/test-plan.md`.

## Atalhos

| Atalho | Ação |
|---|---|
| ⌘K | paleta (projetos, sessões, comandos, mods, ▶ rodar) |
| ⌘G | grade de sessões |
| ⌘J | próxima sessão que precisa de você |
| ⌘1…9 | projeto N da barra lateral |
| ⌘T / ⌘D / ⌘⇧D | nova aba / dividir com terminal / dividir com Claude |
| ⌘⇧↩ | expandir/restaurar o painel focado |
| ⌘. | interromper (⌃C) · ⌘⇧W encerra a sessão |
| ⌘E / ⌘⇧B / ⌘B | árvore / browser / barra lateral |
| ⌘F | buscar no terminal · ⌘⇧K limpa a tela |
| ⇧↩ | nova linha no Claude (`\x1b\r`, igual ao seu atalho do Cursor) |
| ⌥← ⌥→ ⌥⌫ ⌘← ⌘→ ⌘⌫ | edição de linha estilo Mac |
| ⌘W | fecha a janela; as sessões continuam rodando |

## Como o status funciona

1. **OSC 7501** — o Claude Code pergunta ao terminal se ele entende "program status"; o Cockpit responde e passa a receber `working`/`blocked`/`done`/`idle` com título da tarefa. Lido no processo principal, direto do fluxo do pty.
2. **Hooks por sessão** — sessões do Claude abertas pelo Cockpit recebem `--plugin-dir resources/claude-plugin`. O plugin só existe nessa sessão: **nada é escrito em `~/.claude`**. O `report.sh` envia o JSON do hook por um socket Unix privado (0600) com token aleatório.
3. **Heurística** — Codex (OSC 9), BEL, título e atividade de saída.

Cada Claude novo recebe `--session-id <uuid>` gerado pelo Cockpit, então "Retomar conversa" abre exatamente aquela conversa.

## Mods do Cockpit

Ficam em `~/.cockpit/mods/<id>/manifest.json` (a pasta é criada com dois exemplos na primeira abertura). Recarregue em **Mods → Recarregar**.

```json
{
  "id": "meu-mod",
  "name": "Meu mod",
  "version": "1.0.0",
  "main": "main.js",
  "permissions": ["session.events", "session.write", "notify", "browser"],
  "buttons": [{ "id": "b1", "label": "Fazer algo", "icon": "⚡", "location": "sidebar", "action": { "type": "script" } }],
  "commands": [{ "id": "c1", "title": "Meu comando", "action": { "type": "type", "text": "/compact", "enter": true } }],
  "panels": [{ "id": "p1", "title": "Meu painel", "html": "panel.html" }]
}
```

**Ações declarativas** (sem código): `type` (digita na sessão focada), `spawn` (`agent`: claude/codex/shell), `openUrl` (localhost ou arquivo do projeto no browser lateral), `launch` (último ▶ do projeto) e `script` (chama o `main.js`).

**API do `main.js`** (`window.cockpit`), roda isolado, sem internet e sem acesso a arquivos:

| Função | Permissão |
|---|---|
| `onSessionEvent(cb)` — `{sessionId, projectId, projectName, agent, title, activity, lifecycle, detail}` (nunca o conteúdo do terminal) | `session.events` |
| `listSessions()` | `session.events` |
| `notify(title, body)` | `notify` |
| `sendToSession(sessionId, text)` — texto simples, 4 KB, 1×/s, pede confirmação na 1ª vez, mostra "mod digitou" | `session.write` |
| `openUrl(projectId, url)` | `browser` |
| `onAction(cb(actionId, {projectId, sessionId}))` | — |
| `postToPanel(panelId, msg)` / `onPanelMessage(cb(panelId, msg))` | — |

O painel (`panel.html`) roda num iframe sandbox: recebe `{kind: 'cockpit', message}` via `message` e responde com `parent.postMessage({message}, '*')`. Veja `resources/mods-examples/`.

## Hermes (canal de controle)

O Hermes usa o Cockpit como terminal. Ele se conecta ao Cockpit aberto (ou o abre) por um socket Unix privado em `~/Library/Application Support/Cockpit/run/control.sock` (0600, pasta 0700). A primeira linha precisa trazer o token desta execução, gravado em `run/control.token` (0600), que é diferente do token dos hooks. O protocolo usa uma linha JSON por mensagem, na versão 1 (`src/main/control/`):

- `open {projectPath}`: adiciona a pasta como projeto se precisar, traz a janela e mostra o projeto. Se nada estiver rodando nele, abre o último agente usado.
- `request {projectPath, prompt, remoteName}`: inicia `claude --remote-control="<nome> · Hermes" --permission-mode=plan -- <pedido>` num painel "Claude · Hermes". Se esse Claude já estiver rodando, cola o texto nele (colagem entre colchetes, depois Enter). Por 3 min, o Cockpit procura na saída o link `claude.ai/code/session_…` ou a pergunta de confiar na pasta e avisa o Hermes com o evento `remote`.
- `finish {projectPath}` e `interruptHermes`: encerram só as sessões marcadas como do Hermes (`origin: 'hermes'`). As suas nunca são encerradas por ele. O painel fica com a saída e o botão "Retomar conversa".

Não há URL scheme, então uma página web não consegue disparar pedidos. Nenhum comando executa texto arbitrário: o prompt vira um único argumento do `claude`, sem passar por um shell.

## Segurança (herdada do Hermes)

- Ambiente do pty por lista branca; variáveis do Cursor/VS Code, `NODE_OPTIONS`, `DYLD_*`, `ELECTRON_*` e tokens nunca chegam ao shell.
- Nenhuma flag que pule permissões dos agentes (teste garante).
- OSC 52 (clipboard) bloqueado nos dois sentidos — o Claude copia via `pbcopy`. Links só http/https e só com clique.
- Árvore, prévia e `preview://` confinados à pasta do projeto (`realpath` em todos os níveis); arquivos nunca são executados.
- Browser lateral em partição só de memória; navegação fora de localhost/arquivos do projeto vai para o navegador padrão.
- Nada da saída dos terminais é gravado em disco.

## Diferenças em relação ao Hermes

- Sessões **continuam vivas** no repouso do Mac (o Hermes encerrava).
- Sem Touch ID, sem processo auxiliar/pipes, sem cascata de janelas.

Pesquisa e decisões: `docs/research/` e `docs/spike.md`.
