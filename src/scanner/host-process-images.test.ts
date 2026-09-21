import { describe, expect, it } from 'vitest';
import { imagesFromProcessEntries, matchProcesses } from './host-process.js';

describe('imagesFromProcessEntries', () => {
  it('builds the image set from the shared process snapshot', () => {
    const images = imagesFromProcessEntries([{ name: 'Hora.exe' }, { name: 'node.exe' }, {}]);
    expect(images).toEqual(new Set(['Hora.exe', 'node.exe']));
    expect(matchProcesses([{ code: 'hora-app', process_match: 'hora.exe' }], images!)).toEqual(new Set(['hora-app']));
  });

  it('returns null when the snapshot carries no names (so the caller asks the OS)', () => {
    expect(imagesFromProcessEntries([{}, {}])).toBeNull();
  });
});
