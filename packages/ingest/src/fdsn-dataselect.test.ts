import { describe, expect, it, vi } from 'vitest';
import { DATASELECT_URL, dataselectPostBody, fetchDataselect } from './fdsn-dataselect';

const ADO = { network: 'CI', station: 'ADO', location: '', channel: 'HHZ' };
const ANMO = { network: 'IU', station: 'ANMO', location: '00', channel: 'BHZ' };
const START = Date.parse('2019-07-06T03:18:30Z');
const END = Date.parse('2019-07-06T03:21:30.5Z');

describe('dataselectPostBody', () => {
  it('writes one line per channel, a blank location as --, and times without a Z', () => {
    expect(dataselectPostBody([ADO, ANMO], START, END)).toBe(
      'CI ADO -- HHZ 2019-07-06T03:18:30.000 2019-07-06T03:21:30.500\n' +
        'IU ANMO 00 BHZ 2019-07-06T03:18:30.000 2019-07-06T03:21:30.500',
    );
  });
});

describe('fetchDataselect', () => {
  it('POSTs the bulk body to the EarthScope host', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 })));
    const bytes = await fetchDataselect([ADO], START, END, { fetchImpl });
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(DATASELECT_URL);
    expect(url).toContain('service.earthscope.org');
    expect(init.method).toBe('POST');
  });

  it('reads 204 as "the archive holds nothing", which is an answer', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    expect((await fetchDataselect([ADO], START, END, { fetchImpl })).byteLength).toBe(0);
  });

  it('throws on any other failure, so a dropped request never reads as silence', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('busy', { status: 503 })));
    await expect(fetchDataselect([ADO], START, END, { fetchImpl })).rejects.toThrow(/503/);
  });

  it('asks for nothing when given no channels', async () => {
    const fetchImpl = vi.fn();
    expect((await fetchDataselect([], START, END, { fetchImpl })).byteLength).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
