import { describe, expect, it } from 'vitest'
import { arrange, autoCells, moveInSlots, presetOf, PRESETS, pruneTree, slotRects } from '../../src/renderer/src/layout/presets'

describe('layouts da aba', () => {
  const quad = presetOf('quad')!
  it('cada layout cobre todos os espaços uma vez e preenche o quadro', () => {
    for (const p of PRESETS) {
      const rects = slotRects(p.tree)
      expect(rects.map((r) => r.slot).sort()).toEqual([...Array(p.slots).keys()])
      expect(rects.reduce((a, r) => a + r.w * r.h, 0)).toBeCloseTo(1)
    }
  })

  it('arrange: respeita a ordem salva, preenche vazios e recusa excesso', () => {
    expect(arrange(quad, undefined, ['a', 'b'])).toEqual(['a', 'b', null, null])
    expect(arrange(quad, [null, null, 'b', 'a'], ['a', 'b', 'c'])).toEqual(['c', null, 'b', 'a'])
    // Sessão que fechou some; a nova entra no primeiro espaço livre.
    expect(arrange(quad, ['x', 'a', null, null], ['a', 'n'])).toEqual(['n', 'a', null, null])
    expect(arrange(presetOf('cols2')!, undefined, ['a', 'b', 'c'])).toBeNull()
  })

  it('moveInSlots: centro troca, bordas encaixam antes/depois, espaço vazio recebe', () => {
    expect(moveInSlots(['a', 'b', 'c', null], 'a', 2, 'center')).toEqual(['c', 'b', 'a', null])
    expect(moveInSlots(['a', 'b', 'c', null], 'a', 3, 'center')).toEqual([null, 'b', 'c', 'a'])
    expect(moveInSlots(['a', 'b', 'c', null], 'c', 0, 'before')).toEqual(['c', 'a', 'b', null])
    expect(moveInSlots(['a', 'b', 'c', null], 'a', 1, 'after')).toEqual(['b', 'a', 'c', null])
    expect(moveInSlots(['a', 'b'], 'a', 0, 'center')).toEqual(['a', 'b'])
  })
})

describe('App no layout', () => {
  it('o App ocupa um espaço como um terminal e pode ser movido', () => {
    const p = presetOf('mainLeft')!
    const slots = arrange(p, [null, 'app', null], ['a', 'app'])
    expect(slots).toEqual(['a', 'app', null])
    expect(moveInSlots(slots!, 'app', 0, 'center')).toEqual(['app', 'a', null])
    expect(arrange(presetOf('cols2')!, undefined, ['a', 'b', 'app'])).toBeNull()
  })
  it('automático: segue a ordem salva e põe os novos no fim', () => {
    expect(autoCells(['b', 'app', 'x'], ['a', 'b', 'app'])).toEqual(['b', 'app', 'a'])
  })
})

describe('remover espaço livre (×)', () => {
  const grid6 = presetOf('grid6')!
  it('poda a árvore: a vizinha cresce e divisões de uma parte só somem', () => {
    expect(pruneTree(grid6.tree, [])).toEqual(grid6.tree)
    expect(pruneTree(grid6.tree, [3, 4, 5])).toEqual({ dir: 'row', parts: [0, 1, 2], ratio: [1, 1, 1] })
    expect(pruneTree(grid6.tree, [1, 2, 3, 4, 5])).toBe(0)
    const ml = presetOf('mainLeft')!
    expect(pruneTree(ml.tree, [2])).toEqual({ dir: 'row', parts: [0, 1], ratio: [3, 2] })
  })

  it('espaço removido nunca recebe sessão e conta na capacidade', () => {
    expect(arrange(grid6, ['a', null, null], ['a', 'b'], [1])).toEqual(['a', null, 'b', null, null, null])
    // Ordem salva apontando para um espaço removido: vai para o primeiro livre.
    expect(arrange(grid6, [null, 'a'], ['a'], [1])).toEqual(['a', null, null, null, null, null])
    expect(arrange(presetOf('cols2')!, [], ['a', 'b'], [1])).toBeNull()
  })
})
