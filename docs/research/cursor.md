# O que você perde ao trocar o Cursor pelo novo app de terminal

## Resposta curta

Você perde pouca coisa. Muda principalmente o aplicativo. Os dados mostram que você usa o Cursor como um invólucro do terminal onde roda o Claude Code e o Codex. As partes "inteligentes" do Cursor (autocomplete, agente próprio, edição inline, editor de código) quase não aparecem no seu histórico. Há duas exceções reais:
1. **Abrir e visualizar arquivos rapidamente**, inclusive mídia e HTML.
2. **Ter um editor por perto** nas raras vezes em que você precisa olhar ou corrigir código à mão.

As duas se resolvem deixando o Cursor instalado como apoio, com um botão "Abrir no Cursor" no app.

## Evidências coletadas (somente leitura)

- **Extensões instaladas no Cursor:** só três.
  - `anthropic.claude-code`.
  - `anysphere.remote-ssh` e `anysphere.remote-containers`, que o próprio Cursor instala por padrão (`glass.remoteSshExtensionInstalledByDefault`).
  - Nenhuma extensão de linguagem: nada de ESLint, Prettier, Python ou Swift.
- **`settings.json`:** são 5 chaves, e quase todas tratam de terminal ou Claude.
  - `terminal.integrated.gpuAcceleration: "off"` e `mouseWheelScrollSensitivity: 3`. Desligar a GPU provavelmente foi uma tentativa de corrigir a renderização.
  - `claudeCode.preferredLocation: "panel"`.
  - `cursor.composer.shouldChimeAfterChatFinishes: true`.
  - `window.autoDetectColorScheme`.
- **`keybindings.json`:** um único atalho. `shift+enter` no terminal envia `\u001b\r`, que é a quebra de linha do Claude Code. **O app novo precisa repetir isso.**
- **MCP:** não existe `~/.cursor/mcp.json` nem `.cursor/mcp.json` nos projetos.
- **Agente nativo do Cursor (Composer/Agent):** dos 386 registros `composerData`, só 6 têm mensagens.
  - Quatro são de junho e dois de outubro.
  - O maior tem 111 mensagens, em 21/10, sobre "Opera browser CLI issue".
- **Cursor Tab e código gerado por IA:** `~/.cursor/ai-tracking/ai-code-tracking.db` tem 0 registros em `ai_code_hashes`. O arquivo não muda desde 16/06.
- **Edição manual de código:** o histórico local de edições (`Cursor/User/History`) tem só 3 arquivos, e são `settings.json` e `workspace.json`. Não há nenhum arquivo de código salvo pelo editor. Há uma ressalva: esse histórico pode ser podado, então a evidência é forte, mas não absoluta.
- **Arquivos vistos recentemente (`~/.cursor/ide_state.json`):** `.xls`, `.mp4`, `.wav`, `.html`, `.zip`, `involves.py`. Ou seja, você usa o Cursor como **visualizador de arquivos** dos projetos.
- **Claude Code:** 815 sessões em `~/.claude/projects`. Todas têm `entrypoint: "cli"` (mais 232 entradas `sdk-cli`), e nenhuma tem `claude-vscode`.
  - Você **nunca usou o painel gráfico da extensão**, apesar do `preferredLocation: panel`. Usa o CLI no terminal do Cursor.
- **Integração `/ide` do Claude Code com o Cursor:** a conexão existe (`~/.claude/ide/26636.lock` com `ideName: Cursor`), mas quase não é usada.
  - `<ide_opened_file>` e `<ide_selection>` aparecem em 1 das 815 sessões.
  - `openDiff` também aparece em 1.
  - Chamadas reais de `mcp__ide__getDiagnostics`: 0.
- **Shell (`~/.zsh_history`):** cerca de 410 linhas com `claude` e cerca de 237 com `codex`.
- **Projetos:** são cerca de 40 workspaces recentes, quase todos pastas do Desktop e algumas do Google Drive. Coisas específicas do Cursor/VS Code:
  - `MonitoRT/.cursor/rules/opera-browser-cli.mdc` (`alwaysApply`). Só vale para o agente do Cursor, que você quase não usa.
  - `MonitoRT/.vscode/tasks.json`, com as tarefas "GitHub: publicar MonitoRT" e "Opera: …".
  - `Cortecloud/Cortecloud.code-workspace`, que tem uma pasta só e nenhuma configuração.
  - Vários `AGENTS.md`, que valem para o Codex, não para o Cursor.
- **Git:** as credenciais vêm de `credential.helper=osxkeychain` e do `gh` autenticado (`rcteixeira2-coder`, keyring). `git push` e `gh` **não dependem do Cursor**.
  - O Cursor tem um login GitHub próprio, usado hoje às 07:50, mas ele só serve à interface de Git dele.

## Tabela: o que muda para você

| Recurso do Cursor | Você usa? (evidência) | Impacto de perder | Mitigação |
|---|---|---|---|
| Editor de código com LSP/IntelliSense | Praticamente não: nenhuma extensão de linguagem, nenhum arquivo de código no histórico de edição | Baixo | Botão "Abrir no Cursor" por projeto e por arquivo (`cursor <caminho>`), mantendo o Cursor instalado |
| Visualizar arquivos (HTML, mp4, wav, xls, py) | **Sim**: `recentlyViewedFiles` cheio de mídia e HTML | **Médio** | Árvore de arquivos com prévia: imagem, vídeo e áudio nativos do Chromium, HTML no navegador lateral, código com destaque de sintaxe. Mais "Abrir com app padrão" (`shell.openPath`) e "Mostrar no Finder" |
| Cursor Tab (autocomplete) | Não: `ai_code_hashes` = 0 | Nenhum | — |
| Chat, Agent e Composer do Cursor | Quase nunca: 6 conversas no total | Baixo | O Claude e o Codex no app fazem esse papel |
| Edição inline Cmd+K | Sem evidência de uso | Nenhum | — |
| Tela de revisão de diffs da IA (aceitar/rejeitar) | Não: o Claude Code CLI mostra o diff no próprio terminal; `openDiff` aparece em 1 de 815 sessões | Baixo | Opcional (fase 2): visualizador de `git diff` por projeto no app |
| Interface de Git e controle de versão | Fraca: o GitHub é usado pela interface do Cursor, mas o `push` funciona sem ele (keychain + `gh`) | Baixo | Mostrar na barra lateral a branch e um selo de "alterações pendentes". O push continua via Claude ou o skill UploadNoGithub |
| Debugger | Não: nenhum `launch.json` | Nenhum | Abrir no Cursor se um dia precisar |
| Extensões | Só a do Claude Code; as de Remote vêm de fábrica | Nenhum | O sistema de mods do app substitui com vantagem |
| Busca em todos os arquivos | Sem evidência; quem busca é o Claude/Codex | Baixo | Opcional: busca com `rg` no app |
| Multi-root / `.code-workspace` | Não: o único workspace tem uma pasta | Nenhum | A barra lateral de projetos já cobre |
| Remote SSH / Containers | Não: vieram instalados por padrão, sem sinal de uso | Nenhum | Abrir sessão `ssh` numa aba, se precisar |
| Rules (`.cursor/rules`) e MCP do Cursor | Uma regra no MonitoRT, só para o agente do Cursor; MCP nenhum | Baixo | Se quiser essa instrução no Claude, ela precisa ir para `CLAUDE.md` ou um skill (você já tem o skill `opera-browser-cli`) |
| `tasks.json` (publicar no GitHub, Opera) | Existe só no MonitoRT; uso pelo Cursor não confirmado | Baixo | Ler `.vscode/tasks.json` e mostrar as tarefas como botões, ou recriar como mods |
| Integração `/ide` do Claude Code (diffs no editor, seleção, diagnósticos) | Conectada, mas quase sem uso (1 de 815 sessões, 0 diagnósticos) | Baixo | Continua funcionando com o Cursor aberto ao lado: o lock é por workspace e `/ide` conecta mesmo de fora |
| Som ao terminar o chat | **Sim**: `shouldChimeAfterChatFinishes` ligado | Médio, porque você quer o aviso | Já está no plano: notificações do macOS e som pelos hooks `Stop`/`Notification` |
| `shift+enter` no terminal | **Sim**: atalho personalizado | **Alto se esquecer** | Mapear `shift+enter` → `\x1b\r` no xterm.js desde o primeiro dia |
| Terminal integrado (onde você realmente trabalha) | **Sim**, uso principal (815 sessões, todas pelo CLI) | É o que você ganha | É o produto em si: mods bem renderizados, várias sessões, status por sessão |

## Recomendação

**Use o app como substituto no dia a dia e deixe o Cursor instalado para quando precisar dele.**

- **O que muda:** o app novo vira o lugar onde você trabalha. Ele cobre tudo o que os dados mostram que você realmente usa no Cursor: o terminal com Claude e Codex, o aviso de "terminou", os vários projetos e a visualização de arquivos.
- **O que fica com o Cursor:** não precisa desinstalar. Use quando quiser ler ou editar código à mão com destaque de sintaxe e navegação, quando quiser ver um diff grande ou se um dia precisar de debugger.

Para isso funcionar sem atrito, o MVP precisa de quatro itens que hoje não estão no plano:
1. `shift+enter` → `\x1b\r` no terminal.
2. Botão **"Abrir no Cursor"** no projeto, no arquivo e na sessão (`cursor <path>` ou `open -a Cursor <path>`).
3. Prévia de arquivos na árvore (imagem, vídeo, áudio, HTML, texto e código) mais "Abrir com app padrão" e "Mostrar no Finder". Hoje isso é o seu uso real do Cursor, e uma árvore só de leitura sem prévia deixaria uma lacuna.
4. Som e notificação ao fim de cada sessão, para substituir o aviso sonoro do Cursor.

Fica para uma fase 2: visualizador de `git diff` por projeto, branch e alterações pendentes na barra lateral, e as tarefas do `.vscode/tasks.json` como botões.

O que não vale construir: um editor com LSP, autocomplete, chat próprio ou debugger. Você não usa nada disso, e seria recriar o Cursor sem necessidade.

Ressalvas:
- O histórico local de edições do Cursor pode ser podado, então "nunca edita à mão" é uma conclusão forte, mas não certa.
- O uso da interface de Git do Cursor não deu para medir. O fato confirmado é que o `push` não depende dele.
- Não alterei nenhum arquivo do sistema nem dos projetos. A única coisa criada foi uma pasta temporária vazia dentro do scratchpad da sessão (`/private/tmp/claude-501/-Users-rodrigoteixeira-Desktop-Terminal/1fbd14b6-2863-4dbe-a1fc-80cd79a4898f/scratchpad/x.*`), por um `mktemp` que sobrou num comando.

Arquivos consultados:
- `/Users/rodrigoteixeira/Library/Application Support/Cursor/User/settings.json`
- `/Users/rodrigoteixeira/Library/Application Support/Cursor/User/keybindings.json`
- `/Users/rodrigoteixeira/Library/Application Support/Cursor/User/globalStorage/state.vscdb` e `storage.json`
- `/Users/rodrigoteixeira/.cursor/extensions/extensions.json`
- `/Users/rodrigoteixeira/.cursor/ide_state.json`
- `/Users/rodrigoteixeira/.cursor/ai-tracking/ai-code-tracking.db`
- `/Users/rodrigoteixeira/.claude/ide/26636.lock`
- `/Users/rodrigoteixeira/Desktop/MonitoRT/.cursor/rules/opera-browser-cli.mdc`
- `/Users/rodrigoteixeira/Desktop/MonitoRT/.vscode/tasks.json`

---
TOPICO: Impacto de deixar o Cursor pelo app
RESUMO: Analisei, só lendo, configurações, extensões, histórico e bancos do Cursor e as 815 sessões do Claude Code. Você usa o Cursor quase só como terminal do Claude e do Codex e como visualizador de arquivos: Tab, agente próprio, edição manual, MCP e `/ide` quase não aparecem. Perda baixa; muda principalmente o aplicativo.
PROXIMO PASSO: Incluir no plano do MVP: `shift+enter` → `\x1b\r`, botão "Abrir no Cursor", prévia de arquivos na árvore e som/notificação ao fim de cada sessão. Deixar diff/git e tarefas para a fase 2.
---