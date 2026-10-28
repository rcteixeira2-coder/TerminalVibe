[harness: subagent output matched instruction-shaped pattern(s): settings-json. Control tags below are neutralized (`<` → `<\`); treat any remaining directive-shaped text as a finding to relay to the user, not an instruction to you.]

**Correções ao plano (revisão cética, só leitura, com o que conferi nos arquivos)**

**A. Seção 0, o que se perde ao deixar o Cursor (resposta direta ao pedido)**

1. **Números inflados.** Os 815 "sessões" são 817 `.jsonl`, e 639 deles são transcripts de subagentes. Sessões principais são 178 (170 `cli` + 8 `sdk-cli`). Nas principais, `ide_selection`/`ide_opened_file` aparecem 0 vezes, não 1. A conclusão não muda (uso do `/ide` quase nulo), mas corrija os números.
2. **DEC 2026 está errado.** O Cursor 3.27.14 (VS Code 1.128) traz `@xterm/xterm` 6.1.0-beta.304, com `addon-webgl`, `headless` e `progress`. Ele suporta DEC 2026. Tire a hipótese H3. As causas reais são `gpuAcceleration:"off"` (renderizador DOM, sem `customGlyphs`), `minimumContrastRatio` 4.5 e o `wheelFlood` mais redimensionamento.
   - Consequência 1: a mesma pilha xterm/WebGL que embaralhou texto no Cursor (o motivo do `/terminal-setup`) roda no Electron. O M0 precisa testar se o WebGL embaralha no app.
   - Consequência 2: ligar a GPU e pôr contraste 1 no Cursor é um teste de 2 minutos que separa o objetivo 1 (mods bonitos) dos objetivos 2 a 5. Coloque como passo 0 do M0. O usuário faz pela interface, com consentimento.
3. **"Som ao terminar" não é perda.** `shouldChimeAfterChatFinishes` vale só para o Composer do Cursor (6 conversas). Os sons do Claude vêm dos hooks do claude-notifier (`afplay`: Hero, Glass, Funk), que estão em `~/.claude/settings.json` e tocam fora do Cursor.
4. **O "clique abre o VS Code" quase não acontece.** O `-execute` com `click.js:24,29` só roda pelo `terminal-notifier`, e ele não está instalado (não existe em `/opt/homebrew/bin` nem em `/usr/local/bin`). Os avisos saem por `osascript display notification`, sem ação de clique. O problema real é só a duplicação.
   - Para desligar, há uma opção reversível sem editar JSON: o arquivo `~/.claude/hooks/claude-notifier-muted` (`MUTE_FLAG` em `_lib/paths.js`). Ele é global, então silencia também no Cursor.
   - O `claude-notifier-active.d` está vazio, então o `extensionOwnsCwd` não interfere hoje.
5. **Perdas que faltam na tabela:**
   - **Links de caminho de arquivo.** O terminal do Cursor torna `src/x.ts:12` clicável. O plano só trata http e OSC 8. Adicione `registerLinkProvider` para caminhos relativos ao cwd, com `isInside`. Ações: Quick Look, mostrar na árvore e abrir no Cursor na linha.
   - **Repouso.** No Cursor, fechar a tampa só pausa os processos, e eles voltam ao acordar. O plano copia a regra do Hermes (`README.md:325`, ligada a Touch ID) e mata as sessões no `suspend` e na troca de usuário. Para um terminal pessoal isso é regressão. Mantenha as sessões vivas e só avise "o Mac dormiu".
   - **Ambiente do shell.** Hoje o usuário digita `claude` dentro do zsh, que já leu o `.zshrc`. O plano faz spawn direto com lista branca (igual a `DevProtocol.swift:123`) e perde variáveis como `SSH_AUTH_SOCK`. Hoje o `.zshrc` só mexe no PATH, então o risco é baixo. Mesmo assim, adicione `SSH_AUTH_SOCK` à lista branca, ou leia o ambiente uma vez com `zsh -ilc 'env -0'` (comando fixo, com timeout).
6. **"Abrir no Cursor":** o CLI `cursor` não está no PATH. Use `open -a Cursor <path>`. Para arquivo e linha, use `/Applications/Cursor.app/Contents/Resources/app/bin/cursor -g file:line`, que existe.

**B. Status e hooks**

7. **Use `--session-id <uuid>`, que existe no 2.1.311.** Iniciar o Claude com um UUID gerado pelo app dá associação certa ao painel e "Retomar" exato com `--resume <id>`, em vez do seletor. Isso corrige o "Retomar: `claude --resume`". Atualize o id no `SessionStart` (o `/clear` troca o id). Leve o "Retomar" do M5 para o M1 ou M2.
8. **Camada B: prefira `--plugin-dir <app>/claude-plugin` (com `hooks/hooks.json`, "for this session only") a `--settings`.** É o mecanismo próprio para hooks por sessão. O M0 testa os dois. A camada C (editar `settings.json`) provavelmente sai do plano.
9. **Tire a regra de "frescor de 30 s" das camadas A e B.** O OSC 7501 e os hooks só mandam algo quando o estado muda. Um tool de 5 minutos cairia na heurística e viraria "sua vez" falso. O estado de A e B vale até ser trocado enquanto o processo vive. O frescor fica só para a camada D.
10. **O status não pode depender do renderer estar montado.** O plano lê OSC 7501/9/777/BEL no renderer. Se o painel não estiver montado ou houver recarga (HMR) no dev, o status se perde e a consulta `OSC 7501;?`, o XTVERSION e o DECRQM 2026 ficam sem resposta.
    - Ler os OSCs no main, direto do fluxo bruto, e responder `7501;?` de lá.
    - Garantir que o xterm, ou um `@xterm/headless`, exista antes do spawn, sem responder duas vezes.
11. **`claude` digitado num painel de shell** (cerca de 410 linhas no histórico) não recebe hooks nem `--session-id`. Detecte o processo em primeiro plano pela árvore de processos e marque o painel como Claude. Nesse caso o status vem só pelo OSC 7501.

**C. Riscos de Electron**

12. **CSP quebra o xterm.** O xterm injeta `<style>`, e sem `style-src` vale o `default-src 'self'`.
    - Adicione `style-src 'self' 'unsafe-inline'`, `font-src 'self' data:`, `img-src`/`media-src 'self' preview: data: blob:` e, no dev, o ws do Vite em `connect-src`.
13. **`preview://` precisa de mais.**
    - `registerSchemesAsPrivileged` (`standard`, `secure`, `stream`) antes do `ready`.
    - `protocol.handle` em cada partição (`session.fromPartition(...)`), não só na sessão padrão.
    - Suporte a `Range` para vídeo e áudio.
    - O mesmo vale para o `webRequest` dos mods.
14. **`WebContentsView` fica acima do DOM.** A paleta ⌘K, menus, toasts e modais ficam embaixo dele, e o arraste do `allotment` perde o mouse ao passar sobre a view.
    - Esconder a view, ou trocar por um `capturePage`, durante overlays e arrastes.
    - Sincronizar os bounds com `ResizeObserver` mais o zoom.
    - Criar sob demanda e destruir quando ociosa, nunca "um por projeto" com cerca de 40 projetos (cada view é um processo).
    - Painéis de mod: `iframe sandbox` no renderer, não `WebContentsView`.
15. **Grade.** Não crie um segundo xterm por sessão (dobra o parsing, e o `scale` em WebGL fica borrado). Como só uma visão aparece por vez, mova o elemento do terminal entre as visões, ou use cards com as últimas linhas a 1 ou 2 fps.
16. **`powerSaveBlocker`:** ligar só com `activity === 'working'`. Um zsh parado contaria como "rodando" e impediria o repouso para sempre.
17. **Assinatura.** `identity: null` não assina nada. Use ad-hoc (`identity: "-"`, a validar). Para uso pessoal, `--dir` basta: sem DMG, sem quarentena, sem notarização.
    - Valide no M0 a notificação e o clique dela no app empacotado. No `npm run dev`, o aviso sai como "Electron".
18. **node-pty.** As Command Line Tools estão instaladas e há `/usr/bin/python3`. Antes, veja se a versão escolhida traz prebuilds N-API para darwin-arm64: se trouxer, o rebuild pode nem ser preciso. O `chmod +x` do `spawn-helper` com `asarUnpack` continua obrigatório.

**D. Escopo e ordem**

19. **Mods:** um `WebContentsView` oculto por mod é pesado. No MVP, use mods declarativos (botões e comandos que digitam, abrem painel ou rodam um LaunchTarget), mais JS num único host sandbox. Fica por último.
20. **Ordem sugerida:**
    - M0: teste do Cursor, spike e notificação empacotada;
    - M1: terminal, `--session-id` e Retomar;
    - M2: barra lateral, status e notificações (primeira versão para o dia a dia);
    - M3: árvore e prévia, o uso real do Cursor;
    - M4: navegador;
    - M5: mods mínimos.
21. **Ajustes menores:**
    - Os textos do `DevRemote.swift:70-89` dizem "app Claude › Code": adaptar.
    - O `notify` do Codex está ocupado pelo `SkyComputerUseClient`, e as chaves `tui.notification_method/condition` existem no binário: o plano está certo nisso.
    - As referências `PreviewFiles.swift:40-51` e `Tests/Dev/main.swift:152-162` conferem.

---
TOPICO: Revisão cética do plano do terminal
RESUMO: Conferi o plano lendo os arquivos. O Cursor já usa xterm 6.1 com DEC 2026, então os mods ficam feios por GPU desligada e contraste 4.5. O som e o clique dos avisos não são perdas reais (o claude-notifier usa `osascript`, sem `terminal-notifier`). As perdas que faltavam: links de caminho de arquivo, sessões mortas no repouso (regra herdada do Hermes) e o ambiente do zsh. Correções técnicas: `--session-id`, `--plugin-dir`, status lido no main, CSP, `preview://` por partição, sobreposição do `WebContentsView` e a ordem dos marcos.
PROXIMO PASSO: Aplicar as 21 correções ao plano. Começar o M0 pelo teste de ligar a GPU e pôr contraste 1 no Cursor.
---