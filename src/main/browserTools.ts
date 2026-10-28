import type { WebContents } from 'electron'
import type { BrowserState } from '@shared/types'
import type { ToolDef, ToolResult } from './agent/tools'

// Ferramentas que cada sessão do Claude aberta pelo Cockpit recebe (MCP `cockpit_browser`): o navegador
// do PRÓPRIO projeto — localhost e arquivos do projeto, partição só em memória. Antes de agir, o painel
// aparece na tela (o usuário vê o que o Claude faz).

export interface BrowserToolDeps {
  open(projectId: string, url?: string): BrowserState | { error: string }
  action(projectId: string, action: 'back' | 'reload'): void
  contents(projectId: string): WebContents | null
  shown(projectId: string): boolean
  withPage<T>(projectId: string, fn: (wc: WebContents) => Promise<T>): Promise<T>
  logs(projectId: string): string[]
  network(projectId: string): string[]
  // Mostra o painel do navegador do projeto e o selo "🤖 <sessão> está usando".
  show(projectId: string, by: string): void
}

const MAX_TEXT = 8000
const MAX_EVAL = 20_000
const EVAL_TIMEOUT_MS = 10_000

const P_TARGET = {
  ref: { type: 'integer', description: 'Número do elemento na lista de browser_read' },
  selector: { type: 'string', description: 'Seletor CSS (alternativa ao ref)' },
  text: { type: 'string', description: 'Texto visível do elemento (alternativa ao ref)' },
}

export const BROWSER_TOOL_DEFS: ToolDef[] = [
  {
    name: 'browser_open',
    description: 'Abre uma página no navegador do Cockpit (painel ao lado do terminal): localhost/127.0.0.1 com porta (ex.: "localhost:3000/login") ou um arquivo do projeto ("/relatorio/index.html"). Use este navegador para ver e testar o app do projeto — não o navegador do usuário.',
    schema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
  },
  { name: 'browser_screenshot', description: 'Print da página atual do navegador do Cockpit.', schema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'browser_read',
    description: 'Título, URL, texto visível e a lista numerada de elementos clicáveis/campos ([n]) da página atual.',
    schema: { type: 'object', properties: {}, required: [] },
  },
  { name: 'browser_click', description: 'Clica num elemento (ref de browser_read, seletor CSS ou texto).', schema: { type: 'object', properties: P_TARGET, required: [] } },
  {
    name: 'browser_type',
    description: 'Digita num campo (ref, seletor ou texto do rótulo). Substitui o conteúdo; submit=true aperta Enter no fim.',
    schema: { type: 'object', properties: { ...P_TARGET, value: { type: 'string', description: 'O que digitar' }, submit: { type: 'boolean' } }, required: ['value'] },
  },
  {
    name: 'browser_press',
    description: 'Aperta uma tecla na página: Enter, Tab, Escape, Backspace, ArrowUp, ArrowDown, ArrowLeft, ArrowRight, PageUp, PageDown, Home, End, Space.',
    schema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  { name: 'browser_scroll', description: 'Rola a página (dy em px; negativo sobe).', schema: { type: 'object', properties: { dy: { type: 'integer' } }, required: ['dy'] } },
  { name: 'browser_console', description: 'Últimas mensagens do console da página (erros, avisos, logs).', schema: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_network', description: 'Requisições da página que falharam ou voltaram com erro (status ≥ 400).', schema: { type: 'object', properties: {}, required: [] } },
  {
    name: 'browser_eval',
    description: 'Executa JavaScript na página e devolve o resultado (JSON). Aceita expressão ou bloco; pode usar await.',
    schema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  },
  { name: 'browser_reload', description: 'Recarrega a página atual.', schema: { type: 'object', properties: {}, required: [] } },
  { name: 'browser_back', description: 'Volta para a página anterior.', schema: { type: 'object', properties: {}, required: [] } },
]

const KEYS: Record<string, string> = {
  Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Space: 'Space', Home: 'Home', End: 'End',
  PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
}

// Mesma lista de elementos em browser_read e na hora de clicar/digitar (o [n] aponta para o mesmo elemento).
const LIST_JS = `
  const __vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' };
  const __label = (el) => (el.getAttribute('aria-label') || (el.labels && el.labels[0] && el.labels[0].innerText) || el.innerText || el.value || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  const __els = () => [...document.querySelectorAll('a[href],button,input:not([type=hidden]),select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable=true],summary')].filter(__vis).slice(0, 200);
`

function findJs(input: Record<string, unknown>): string {
  const ref = Number(input.ref) || 0
  const selector = typeof input.selector === 'string' ? input.selector : ''
  const text = typeof input.text === 'string' ? input.text.toLowerCase() : ''
  return `${LIST_JS}
    const __find = () => {
      const els = __els();
      if (${ref} > 0) return els[${ref} - 1] || null;
      if (${JSON.stringify(selector)}) return document.querySelector(${JSON.stringify(selector)});
      const t = ${JSON.stringify(text)};
      if (!t) return null;
      return els.find((e) => __label(e).toLowerCase().includes(t))
        || [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && __vis(e) && (e.innerText || '').trim().toLowerCase().includes(t))
        || null;
    };`
}

const fail = (content: string, summary: string): ToolResult => ({ ok: false, content, summary })
const ok = (content: string, summary: string): ToolResult => ({ ok: true, content, summary })

function waitLoad(wc: WebContents, ms = 15_000): Promise<void> {
  if (!wc.isLoading()) return Promise.resolve()
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    wc.once('did-stop-loading', () => {
      clearTimeout(t)
      resolve()
    })
  })
}

async function waitShown(deps: BrowserToolDeps, projectId: string, ms = 2500): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (deps.shown(projectId)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return deps.shown(projectId)
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${what}: passou de ${ms / 1000}s`)), ms))])
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (+${text.length - max} caracteres)` : text
}

export async function runBrowserTool(deps: BrowserToolDeps, projectId: string, by: string, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  try {
    deps.show(projectId, by)
    if (name === 'browser_open') {
      const url = typeof input.url === 'string' ? input.url.trim() : ''
      if (!url) return fail('Informe a URL.', 'url vazia')
      const r = deps.open(projectId, url)
      if ('error' in r) return fail(r.error, 'endereço recusado')
      const wc = deps.contents(projectId)
      if (wc) await waitLoad(wc)
      return ok(`Aberto: ${wc?.getURL() ?? r.url} — "${wc?.getTitle() ?? ''}"`, `abriu ${url}`)
    }
    if (name === 'browser_console') {
      const lines = deps.logs(projectId)
      return ok(lines.length ? lines.slice(-100).join('\n') : '(console vazio)', `leu o console (${lines.length})`)
    }
    if (name === 'browser_network') {
      const lines = deps.network(projectId)
      return ok(lines.length ? lines.slice(-100).join('\n') : 'Nenhuma requisição com erro.', `viu a rede (${lines.length} erro${lines.length === 1 ? '' : 's'})`)
    }
    if (name === 'browser_reload' || name === 'browser_back') {
      deps.action(projectId, name === 'browser_reload' ? 'reload' : 'back')
      const wc = deps.contents(projectId)
      if (wc) {
        await new Promise((r) => setTimeout(r, 150))
        await waitLoad(wc)
      }
      return ok(`Agora em: ${wc?.getURL() ?? ''}`, name === 'browser_reload' ? 'recarregou' : 'voltou')
    }

    const current = deps.contents(projectId)
    if (!current) return fail('Navegador indisponível (janela fechada).', 'sem navegador')
    if (!current.getURL() || current.getURL() === 'about:blank') return fail('Nenhuma página aberta. Use browser_open primeiro.', 'nada aberto')
    await waitLoad(current)
    // Dá um instante para o painel aparecer (projeto na tela); senão a página é desenhada fora da vista.
    await waitShown(deps, projectId, 600)
    return await deps.withPage(projectId, (wc) => pageTool(wc, name, input))
  } catch (e) {
    return fail(`Erro: ${(e as Error).message}`, `falhou: ${name}`)
  }
}

// Ações dentro da página (já desenhada: no painel ou fora da vista).
async function pageTool(wc: WebContents, name: string, input: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case 'browser_screenshot': {
      let img = await wc.capturePage()
      if (img.isEmpty()) return fail('A página ainda não foi desenhada; tente de novo em instantes.', 'print vazio')
      if (img.getSize().width > 1400) img = img.resize({ width: 1400 })
      return { ok: true, content: `Print de ${wc.getURL()}`, summary: 'tirou um print', image: { data: img.toJPEG(80).toString('base64'), mimeType: 'image/jpeg' } }
    }
    case 'browser_read': {
      const r = (await wc.executeJavaScript(`(() => { ${LIST_JS}
        const items = __els().map((el, i) => { const tag = el.tagName.toLowerCase(); const type = el.getAttribute('type'); return '[' + (i + 1) + '] ' + tag + (type ? '(' + type + ')' : '') + ' "' + __label(el) + '"' + (el.disabled ? ' (desabilitado)' : '') });
        return { title: document.title, url: location.href, text: document.body ? document.body.innerText : '', items };
      })()`)) as { title: string; url: string; text: string; items: string[] }
      const body = `${r.title} — ${r.url}\n\n${clip(r.text.trim(), MAX_TEXT)}\n\nElementos:\n${r.items.join('\n') || '(nenhum)'}`
      return ok(body, `leu a página (${r.items.length} elementos)`)
    }
    case 'browser_click': {
      const at = (await wc.executeJavaScript(`(() => { ${findJs(input)}
        const el = __find(); if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), label: __label(el) };
      })()`)) as { x: number; y: number; label: string } | null
      if (!at) return fail('Elemento não encontrado. Use browser_read para ver a lista [n].', 'elemento não achado')
      wc.sendInputEvent({ type: 'mouseMove', x: at.x, y: at.y })
      wc.sendInputEvent({ type: 'mouseDown', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      wc.sendInputEvent({ type: 'mouseUp', x: at.x, y: at.y, button: 'left', clickCount: 1 })
      await new Promise((r) => setTimeout(r, 300))
      await waitLoad(wc)
      return ok(`Clicou em "${at.label}". Agora em: ${wc.getURL()}`, `clicou em “${at.label.slice(0, 40)}”`)
    }
    case 'browser_type': {
      const value = typeof input.value === 'string' ? input.value : ''
      const found = (await wc.executeJavaScript(`(() => { ${findJs(input)}
        const el = __find() || (document.activeElement !== document.body ? document.activeElement : null); if (!el) return null;
        el.scrollIntoView({ block: 'center' }); el.focus();
        if (typeof el.select === 'function') el.select();
        else if (el.isContentEditable) document.execCommand('selectAll');
        return __label(el) || el.tagName.toLowerCase();
      })()`)) as string | null
      if (found === null) return fail('Campo não encontrado. Use browser_read para ver a lista [n].', 'campo não achado')
      wc.insertText(value)
      if (input.submit === true) pressKey(wc, 'Enter')
      await new Promise((r) => setTimeout(r, 200))
      await waitLoad(wc)
      return ok(`Digitou em "${found}"${input.submit === true ? ' e apertou Enter' : ''}.`, `digitou em “${found.slice(0, 40)}”`)
    }
    case 'browser_press': {
      const key = KEYS[String(input.key ?? '')]
      if (!key) return fail(`Tecla não suportada. Use: ${Object.keys(KEYS).join(', ')}`, 'tecla inválida')
      pressKey(wc, key)
      await new Promise((r) => setTimeout(r, 150))
      return ok(`Apertou ${input.key}.`, `apertou ${input.key}`)
    }
    case 'browser_scroll': {
      const dy = Math.max(-20_000, Math.min(20_000, Math.round(Number(input.dy) || 0)))
      const y = await wc.executeJavaScript(`window.scrollBy(0, ${dy}); window.scrollY`)
      return ok(`Rolou ${dy}px (posição ${y}).`, `rolou ${dy}px`)
    }
    case 'browser_eval': {
      const code = typeof input.code === 'string' ? input.code : ''
      if (!code.trim()) return fail('Código vazio.', 'código vazio')
      // eval indireto aceita expressão ou bloco; com `return` (ou eval proibido por CSP), roda como corpo de função.
      const script = `(async () => {
        const __ser = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v) } catch { return String(v) } };
        try { return { ok: true, value: __ser(await (0, eval)(${JSON.stringify(code)})) } }
        catch (e) {
          if (!(e instanceof EvalError) && !(e instanceof SyntaxError)) return { ok: false, value: String(e && e.stack || e) };
          try { return { ok: true, value: __ser(await (async () => { ${code}\n })()) } } catch (e2) { return { ok: false, value: String(e2 && e2.stack || e2) } }
        }
      })()`
      const r = (await withTimeout(wc.executeJavaScript(script, true), EVAL_TIMEOUT_MS, 'JavaScript')) as { ok: boolean; value: string }
      return { ok: r.ok, content: clip(String(r.value ?? 'undefined'), MAX_EVAL), summary: r.ok ? 'rodou JavaScript' : 'JavaScript deu erro' }
    }
    default:
      return fail(`Ferramenta desconhecida: ${name}`, `ferramenta desconhecida ${name}`)
  }
}

function pressKey(wc: WebContents, keyCode: string): void {
  wc.sendInputEvent({ type: 'keyDown', keyCode })
  if (keyCode === 'Enter') wc.sendInputEvent({ type: 'char', keyCode: '\r' })
  wc.sendInputEvent({ type: 'keyUp', keyCode })
}
