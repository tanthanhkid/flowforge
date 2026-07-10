import { describe, expect, it } from 'vitest';
import type { PortType } from '../src/api/types.ts';
import { compatible, PORT_COLORS } from '../src/canvas/portColors.ts';

const ALL_TYPES: PortType[] = ['text', 'image', 'video', 'audio', 'json', 'number', 'any'];

describe('compatible', () => {
  it('same concrete type is compatible', () => {
    expect(compatible('text', 'text')).toBe(true);
    expect(compatible('image', 'image')).toBe(true);
  });

  it('different concrete types are not compatible', () => {
    expect(compatible('text', 'video')).toBe(false);
    expect(compatible('image', 'audio')).toBe(false);
    expect(compatible('number', 'json')).toBe(false);
  });

  it('`any` is compatible with every type, on either side', () => {
    for (const t of ALL_TYPES) {
      expect(compatible('any', t)).toBe(true);
      expect(compatible(t, 'any')).toBe(true);
    }
  });
});

describe('PORT_COLORS', () => {
  it('defines a color for all 7 port types', () => {
    for (const t of ALL_TYPES) {
      expect(PORT_COLORS[t]).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(Object.keys(PORT_COLORS)).toHaveLength(ALL_TYPES.length);
  });
});
