// Atalhos de edição do Mac (porte de SafeTerminalView.swift:100-137) + Shift+Enter do Cursor.
// Retorna a sequência a enviar, ou null para deixar o xterm tratar a tecla.
export function mapKey(e: KeyboardEvent): string | null {
  if (e.type !== 'keydown' || e.isComposing) return null
  const { key, metaKey: cmd, altKey: alt, shiftKey: shift, ctrlKey: ctrl } = e
  if (key === 'Enter' && shift && !cmd && !alt && !ctrl) return '\x1b\r'
  if (ctrl) return null
  if (key === 'Backspace' && alt && !cmd) return '\x1b\x7f'
  if (key === 'Backspace' && cmd && !alt) return '\x15'
  if (key === 'Delete' && alt) return '\x1bd'
  if (key === 'ArrowLeft' && alt && !cmd) return '\x1bb'
  if (key === 'ArrowRight' && alt && !cmd) return '\x1bf'
  if (key === 'ArrowLeft' && cmd && !alt) return '\x01'
  if (key === 'ArrowRight' && cmd && !alt) return '\x05'
  return null
}
