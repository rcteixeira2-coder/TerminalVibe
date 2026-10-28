// Layouts de terminais de uma aba (estilo Rectangle). Cada folha (número) é um "espaço" onde cabe um terminal.
export interface SplitNode {
  dir: 'row' | 'col'
  parts: LayoutNode[]
  ratio: number[]
}
export type LayoutNode = SplitNode | number

export interface Preset {
  id: string
  label: string
  slots: number
  tree: LayoutNode
}

const row = (parts: LayoutNode[], ratio = parts.map(() => 1)): SplitNode => ({ dir: 'row', parts, ratio })
const col = (parts: LayoutNode[], ratio = parts.map(() => 1)): SplitNode => ({ dir: 'col', parts, ratio })

export const PRESET_GROUPS: Preset[][] = [
  [
    { id: 'cols2', label: 'Lado a lado', slots: 2, tree: row([0, 1]) },
    { id: 'rows2', label: 'Em cima e embaixo', slots: 2, tree: col([0, 1]) },
  ],
  [
    { id: 'left23', label: 'Dois terços à esquerda', slots: 2, tree: row([0, 1], [2, 1]) },
    { id: 'right23', label: 'Dois terços à direita', slots: 2, tree: row([0, 1], [1, 2]) },
    { id: 'cols3', label: 'Terços', slots: 3, tree: row([0, 1, 2]) },
  ],
  [
    { id: 'mainLeft', label: '1 grande + 2 empilhados', slots: 3, tree: row([0, col([1, 2])], [3, 2]) },
    { id: 'mainRight', label: '2 empilhados + 1 grande', slots: 3, tree: row([col([0, 1]), 2], [2, 3]) },
    { id: 'topWide', label: '1 em cima + 2 embaixo', slots: 3, tree: col([0, row([1, 2])]) },
  ],
  [
    { id: 'quad', label: 'Quadrantes', slots: 4, tree: col([row([0, 1]), row([2, 3])]) },
    { id: 'main3', label: '1 grande + 3 empilhados', slots: 4, tree: row([0, col([1, 2, 3])], [3, 2]) },
    { id: 'grid6', label: 'Grade 3 × 2', slots: 6, tree: col([row([0, 1, 2]), row([3, 4, 5])]) },
  ],
]

export const PRESETS: Preset[] = PRESET_GROUPS.flat()

export function presetOf(id: string | undefined): Preset | undefined {
  return id ? PRESETS.find((p) => p.id === id) : undefined
}

// Espaços do layout com as sessões vivas: respeita a ordem salva e põe as novas nos primeiros espaços livres.
// `removed`: espaços que o usuário tirou (×) — nunca recebem nada. `null` quando há mais sessões do que
// espaços (a aba volta ao modo automático).
export function arrange(preset: Preset, order: (string | null)[] | undefined, ids: string[], removed: number[] = []): (string | null)[] | null {
  const gone = new Set(removed.filter((i) => i >= 0 && i < preset.slots))
  if (ids.length > preset.slots - gone.size) return null
  const live = new Set(ids)
  const slots: (string | null)[] = Array(preset.slots).fill(null)
  ;(order ?? []).forEach((id, i) => {
    if (i < preset.slots && !gone.has(i) && id && live.has(id) && !slots.includes(id)) slots[i] = id
  })
  for (const id of ids) {
    if (slots.includes(id)) continue
    slots[slots.findIndex((x, i) => x === null && !gone.has(i))] = id
  }
  return slots
}

// Árvore do layout sem os espaços removidos: divisões que ficam com uma parte só somem (a vizinha cresce).
export function pruneTree(node: LayoutNode, removed: number[] = []): LayoutNode | null {
  if (typeof node === 'number') return removed.includes(node) ? null : node
  const kept = node.parts.map((p, i) => ({ part: pruneTree(p, removed), ratio: node.ratio[i] })).filter((x) => x.part !== null)
  if (!kept.length) return null
  if (kept.length === 1) return kept[0].part
  return { dir: node.dir, parts: kept.map((x) => x.part!), ratio: kept.map((x) => x.ratio) }
}

// Modo automático: todos lado a lado, na ordem salva (os novos no fim).
export function autoCells(order: (string | null)[] | undefined, ids: string[]): string[] {
  const live = new Set(ids)
  const out = (order ?? []).filter((id): id is string => !!id && live.has(id))
  return [...new Set(out), ...ids.filter((id) => !out.includes(id))]
}

export type DropZone = 'center' | 'before' | 'after'

// Move `id` para o espaço `target`: no centro troca de lugar; nas bordas entra antes/depois e empurra os outros.
export function moveInSlots(slots: (string | null)[], id: string, target: number, zone: DropZone): (string | null)[] {
  const from = slots.indexOf(id)
  if (from < 0 || (from === target && zone === 'center')) return slots
  if (zone === 'center') {
    const next = [...slots]
    next[from] = slots[target]
    next[target] = id
    return next
  }
  const n = slots.length
  const rest = slots.filter((_, i) => i !== from)
  let at = zone === 'before' ? target : target + 1
  if (from < target) at--
  rest.splice(Math.max(0, Math.min(at, rest.length)), 0, id)
  // Mantém o número de espaços: tira um vazio (o mais próximo do fim), se sobrou.
  while (rest.length > n) {
    const i = rest.lastIndexOf(null)
    rest.splice(i >= 0 ? i : rest.length - 1, 1)
  }
  return rest
}

// Retângulos de cada espaço num quadro w×h (ícones do menu).
export function slotRects(node: LayoutNode, x = 0, y = 0, w = 1, h = 1, out: { slot: number; x: number; y: number; w: number; h: number }[] = []) {
  if (typeof node === 'number') {
    out.push({ slot: node, x, y, w, h })
    return out
  }
  const total = node.ratio.reduce((a, b) => a + b, 0)
  let off = 0
  node.parts.forEach((p, i) => {
    const f = node.ratio[i] / total
    if (node.dir === 'row') slotRects(p, x + off * w, y, w * f, h, out)
    else slotRects(p, x, y + off * h, w, h * f, out)
    off += f
  })
  return out
}
