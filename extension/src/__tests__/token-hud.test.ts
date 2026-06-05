import { describe, expect, it } from 'vitest';
import { ratioStyle, fmt } from '../content/token-hud';

describe('token-hud ratioStyle color segments', () => {
  it('is green below 80%', () => {
    expect(ratioStyle(0, 100).label).toBe('green');
    expect(ratioStyle(79, 100).label).toBe('green');
  });

  it('is yellow from 80% to under 100%', () => {
    expect(ratioStyle(80, 100).label).toBe('yellow');
    expect(ratioStyle(99, 100).label).toBe('yellow');
  });

  it('is red at or above 100%', () => {
    expect(ratioStyle(100, 100).label).toBe('red');
    expect(ratioStyle(250, 100).label).toBe('red');
  });

  it('treats zero/invalid threshold as green', () => {
    expect(ratioStyle(500, 0).label).toBe('green');
  });
});

describe('token-hud fmt', () => {
  it('formats thousands and millions', () => {
    expect(fmt(0)).toBe('0');
    expect(fmt(950)).toBe('950');
    expect(fmt(1_500)).toBe('1.5K');
    expect(fmt(128_000)).toBe('128.0K');
    expect(fmt(1_000_000)).toBe('1.00M');
  });
});
