import type { ITheme } from '@xterm/xterm'

// Paleta ANSI no tom quente do Cockpit (fundo = var(--bg) do styles.css). As cores com nome que os mods do Claude usam
// (yellow, cyan, green, magenta, red, gray) ficam saturadas e legíveis com contraste mínimo 1.
export const darkTheme: ITheme = {
  background: '#1a1918',
  foreground: '#ece9e2',
  cursor: '#d97757',
  cursorAccent: '#1a1918',
  selectionBackground: '#5c3a2b',
  selectionForeground: '#ffffff',
  black: '#1a1918',
  red: '#f07a6a',
  green: '#8fc27a',
  yellow: '#e8b65a',
  blue: '#7ea7d8',
  magenta: '#c99ad6',
  cyan: '#74c2c2',
  white: '#c9c4ba',
  brightBlack: '#6f6a62',
  brightRed: '#ff9686',
  brightGreen: '#a6d68f',
  brightYellow: '#f5c977',
  brightBlue: '#9cbde6',
  brightMagenta: '#dbb2e6',
  brightCyan: '#93d6d6',
  brightWhite: '#f5f2ec',
}

export const lightTheme: ITheme = {
  background: '#faf9f5',
  foreground: '#1f1e1b',
  cursor: '#c9663f',
  cursorAccent: '#faf9f5',
  selectionBackground: '#f0d3c4',
  selectionForeground: '#1f1e1b',
  black: '#1f1e1b',
  red: '#c0392b',
  green: '#3c7a2b',
  yellow: '#8f5e15',
  blue: '#2f5f95',
  magenta: '#8a4aa3',
  cyan: '#13707a',
  white: '#6e6a62',
  brightBlack: '#8d887e',
  brightRed: '#d9503f',
  brightGreen: '#4d9a37',
  brightYellow: '#b07a1f',
  brightBlue: '#4377b3',
  brightMagenta: '#a463bf',
  brightCyan: '#1b8a96',
  brightWhite: '#1f1e1b',
}

export function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
