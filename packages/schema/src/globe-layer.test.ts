import { describe, expect, it } from 'vitest';
import type { GlobeLayer } from './globe-layer';

describe('GlobeLayer', () => {
  it('accepts a minimal conforming implementation', () => {
    const layer: GlobeLayer = {
      id: 'test',
      label: 'Test Layer',
      category: 'basemap',
      defaultVisible: true,
      mount: () => {},
      unmount: () => {},
      setTimeWindow: () => {},
      setVisible: () => {},
    };

    expect(layer.id).toBe('test');
    expect(layer.category).toBe('basemap');
  });
});
