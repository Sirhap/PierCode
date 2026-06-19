import { describe, it, expect } from 'vitest'
import { budgetTargetDims } from '../../background/browser/image'

describe('image budget', () => {
  it('downscales to fit the max-dimension budget, preserves aspect', () => {
    expect(budgetTargetDims(2000, 1000, 1000)).toEqual({ width: 1000, height: 500 })
    expect(budgetTargetDims(800, 600, 1000)).toEqual({ width: 800, height: 600 }) // under budget: unchanged
  })
  it('handles portrait (height is longest side)', () => {
    expect(budgetTargetDims(500, 2000, 1000)).toEqual({ width: 250, height: 1000 })
  })
})
