import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import 'allotment/dist/style.css'
import './styles.css'
import { App } from './components/App'
import { init } from './controller'
import { fullText } from './terminal/registry'

// Leitura do texto dos terminais para os testes e2e (mesmo contexto da página, nada novo exposto ao main).
;(window as unknown as { __cockpitTest: unknown }).__cockpitTest = { text: fullText }

void init().then(() => {
  createRoot(document.getElementById('root')!).render(<App />)
})
