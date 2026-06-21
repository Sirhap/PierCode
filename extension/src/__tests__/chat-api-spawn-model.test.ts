/**
 * #9 Planner/Navigator asymmetric model selection.
 *
 * spawn_agent may optionally carry `model` and/or `role` so a coordinator can
 * run a strong model for itself (planning) and dispatch cheaper workers
 * (execution). resolveSpawnModel maps {args.model, args.role} + the batch model
 * (the coordinator's own model) onto the model the sub-agent should run, and is
 * BACKWARD COMPATIBLE: with neither field set it returns the batch model
 * unchanged (today's homogeneous behaviour).
 */
import { describe, it, expect } from 'vitest'
import { resolveSpawnModel } from '../background/chat-api'

describe('resolveSpawnModel (#9 asymmetric model selection)', () => {
  it('defaults to the batch (coordinator) model when no role/model given', () => {
    expect(resolveSpawnModel({ task: 't' }, 'gpt-4o')).toBe('gpt-4o')
    expect(resolveSpawnModel({ task: 't' }, undefined)).toBeUndefined()
  })

  it('honours an explicit model arg, overriding the batch model', () => {
    expect(resolveSpawnModel({ task: 't', model: 'gpt-4o-mini' }, 'gpt-4o')).toBe('gpt-4o-mini')
    // explicit model wins even when a role is also present
    expect(resolveSpawnModel({ task: 't', model: 'custom-x', role: 'planner' }, 'gpt-4o')).toBe('custom-x')
  })

  it('a planner role keeps the strong coordinator model', () => {
    expect(resolveSpawnModel({ task: 't', role: 'planner' }, 'gpt-4o')).toBe('gpt-4o')
  })

  it('a navigator/worker role does not invent a model when none is configured', () => {
    // Without an explicit model arg there is no cheaper slug to pick from
    // (the platform's default model resolution still applies downstream), so
    // fall back to the batch model rather than fabricate one.
    expect(resolveSpawnModel({ task: 't', role: 'navigator' }, 'gpt-4o')).toBe('gpt-4o')
    expect(resolveSpawnModel({ task: 't', role: 'worker' }, 'gpt-4o')).toBe('gpt-4o')
  })

  it('ignores a non-string model and unknown roles (stays on batch model)', () => {
    expect(resolveSpawnModel({ task: 't', model: 42 as unknown as string }, 'gpt-4o')).toBe('gpt-4o')
    expect(resolveSpawnModel({ task: 't', role: 'banana' }, 'gpt-4o')).toBe('gpt-4o')
  })

  it('trims surrounding whitespace on an explicit model and ignores empty', () => {
    expect(resolveSpawnModel({ task: 't', model: '  gpt-4o-mini  ' }, 'gpt-4o')).toBe('gpt-4o-mini')
    expect(resolveSpawnModel({ task: 't', model: '   ' }, 'gpt-4o')).toBe('gpt-4o')
  })
})
