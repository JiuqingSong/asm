import { describe, expect, it } from 'vitest';
import { DMA } from '../src/machine/devices.ts';
import { SoundBlaster, SOUND_RATE } from '../src/machine/sound.ts';
import { Machine } from '../src/machine/machine.ts';
import { CONFIG_OPTIONS, DEFAULT_CONFIG, configWarnings } from '../src/machine/config.ts';
import { assemble } from '../src/asm/assembler.ts';

const CLOCK = 1193182;
const PAGE = [0x87, 0x83, 0x81, 0x82, 0, 0x8b, 0x89, 0x8a];
function programDma(dma: DMA, channel: number, address: number, units: number, auto = true, decrement = false): void {
  const word = channel >= 5, local = channel & 3;
  const base = word ? 0xc0 + local * 4 : local * 2;
  const register = word ? address >> 1 : address;
  dma.out8(word ? 0xd8 : 0x0c, 0);
  dma.out8(base, register & 255); dma.out8(base, (register >> 8) & 255);
  dma.out8(base + (word ? 2 : 1), (units - 1) & 255);
  dma.out8(base + (word ? 2 : 1), (units - 1) >> 8);
  dma.out8(PAGE[channel], address >> 16);
  dma.out8(word ? 0xd6 : 0x0b, 0x48 | local | (auto ? 0x10 : 0) | (decrement ? 0x20 : 0));
  dma.out8(word ? 0xd4 : 0x0a, local);
}

function rig() {
  let clock = 0;
  const dma = new DMA(), memory = new Uint8Array(0x400000);
  const pcm: Float32Array[] = [], rates: number[] = [], interrupts: [number, boolean][] = [], warnings: string[] = [];
  const sound = new SoundBlaster({
    now: () => clock,
    dma: (ch, data) => dma.transfer(ch, data, {
      readLin: a => memory[a], writeLin: (a, v) => { memory[a] = v; },
    }),
    irq: (irq, active) => interrupts.push([irq, active]),
    pcm: (samples, rate) => { pcm.push(samples); rates.push(rate); },
    unsupported: message => warnings.push(message),
  });
  const cmd = (...bytes: number[]) => { for (const b of bytes) sound.out8(0x22c, b); };
  const mixer = (r: number, v: number) => { sound.out8(0x224, r); sound.out8(0x225, v); };
  const mixRead = (r: number) => { sound.out8(0x224, r); return sound.in8(0x225); };
  const advance = (clocks: number) => { clock += clocks; sound.tick(); };
  const to = (at: number) => { clock = at; sound.tick(); };
  const fullVolume = () => { for (let r = 0x30; r <= 0x33; r++) mixer(r, 0xf8); };
  return { sound, dma, memory, pcm, rates, interrupts, warnings, cmd, mixer, mixRead, advance, to,
    fullVolume, now: () => clock, samples: () => pcm.flatMap(chunk => Array.from(chunk)) };
}

describe('SB16 non-PnP PCM hardware', () => {
  it('consumes native Windows95 ASP controls but fails the writable-register presence test when ASP is absent', () => {
    const r = rig();
    r.cmd(0x05);
    expect(r.warnings).toEqual([]);
    r.cmd(0);
    expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    r.cmd(0, 0x03);
    expect(r.sound.in8(0x22a)).toBe(0);
    r.cmd(0x04, 0xfc, 0x04, 0xfa, 0x0f, 0x83);
    const before = r.sound.in8(0x22a);
    r.cmd(0x0e, 0x83, before ^ 0xff, 0x0f, 0x83);
    const after = r.sound.in8(0x22a);
    expect(before).toBe(0xff);
    expect(after).not.toBe(before ^ 0xff);
    r.cmd(0x04, 0xf9, 0x04, 0, 0xe1);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([4, 5]);
    expect(r.warnings).toEqual([]);
    expect(r.dma.mask).toBe(0xff);
    expect(r.pcm).toHaveLength(0);
    expect(r.sound.next).toBe(Infinity);
    r.sound.validateState();
    r.cmd(0x04, 0x70, 0x01);
    expect(r.warnings).toHaveLength(2);
    expect(r.sound.in8(0x22e) & 0x80).toBe(0);
  });

  it('uses an unconnected external ASP bus and reports no ASP version', () => {
    const r = rig();
    for (const register of [0, 5, 8, 0x10, 0x20, 0x55, 0x80, 0x81, 0x82, 0x83, 0xff]) {
      r.cmd(0x0e, register, 0, 0x0f, register);
      expect(r.sound.in8(0x22e) & 0x80).toBe(0x80);
      expect(r.sound.in8(0x22a)).toBe(0xff);
      expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    }
    r.cmd(0x08, 3);
    const version = r.sound.in8(0x22a);
    expect(version >= 0x10 && version <= 0x1f).toBe(false);
    r.cmd(0xe1);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([4, 5]);
    expect(r.warnings).toEqual([]);
    expect(r.interrupts.some(([, active]) => active)).toBe(false);
    expect(r.pcm).toHaveLength(0);
    r.sound.validateState();
  });

  it('passes the native Windows98 DSP firmware identity probe without advertising an ASP', () => {
    const r = rig();
    r.cmd(0x0e, 9, 0, 0x0f, 9);
    expect(r.sound.in8(0x22a)).toBe(0xf8);
    for (const [address, expected] of [
      [0x0e, 0xff], [0x0f, 7], [0x0b, 0], [0x23, 0], [0x24, 0],
      [0x2b, 0], [0x2c, 0], [0x2d, 0], [0x37, 0x38],
    ]) {
      r.cmd(0xf9);
      expect(r.sound.in8(0x22e) & 0x80).toBe(0);
      r.sound.validateState();
      r.cmd(address);
      expect(r.sound.in8(0x22e) & 0x80).toBe(0x80);
      expect(r.sound.in8(0x22a)).toBe(expected);
      expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    }
    r.cmd(0x08, 3, 0x0f, 0x83);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([0xff, 0xff]);
    expect(r.warnings).toEqual([]);
    expect(r.dma.mask).toBe(0xff);
    expect(r.interrupts.some(([, active]) => active)).toBe(false);
    expect(r.pcm).toHaveLength(0);
    expect(r.sound.next).toBe(Infinity);
    r.cmd(0xf9, 0x55, 0xfa);
    expect(r.warnings).toHaveLength(2);
    expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    r.sound.validateState();
  });

  it('passes the original Windows95 SB16 driver E3 copyright probe and drains the reply before E1', () => {
    const r = rig();
    r.cmd(0xe3);
    const expected = 'COPYRIGHT (C) CREATIVE TECHNOLOGY LTD, 1992.\0';
    for (const character of expected) {
      expect(r.sound.in8(0x22e) & 0x80).toBe(0x80);
      expect(r.sound.in8(0x22a)).toBe(character.charCodeAt(0));
    }
    expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    r.cmd(0xe1);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([4, 5]);
    expect(r.sound.in8(0x22e) & 0x80).toBe(0);
    expect(r.warnings).toEqual([]);
  });

  it('reset handshake, busy/FIFO/version, inversion, test register, speaker and separate software IRQ acknowledgements', () => {
    const r = rig();
    r.sound.out8(0x226, 1);
    expect(r.sound.in8(0x22c)).toBe(0x80);
    r.sound.out8(0x226, 0);
    expect(r.sound.in8(0x22e)).toBe(0);
    r.advance(4);
    expect(r.sound.in8(0x22e)).toBe(0x80);
    expect(r.sound.in8(0x22a)).toBe(0xaa);
    r.cmd(0xe1);
    expect(r.sound.in8(0x22c)).toBe(0x80);
    r.advance(2);
    expect(r.sound.in8(0x22c)).toBe(0);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([4, 5]);
    r.cmd(0xe0, 0x55, 0xe4, 0x73, 0xe8);
    expect([r.sound.in8(0x22a), r.sound.in8(0x22a)]).toEqual([0xaa, 0x73]);
    r.cmd(0xd1, 0xd8); expect(r.sound.in8(0x22a)).toBe(0xff);
    r.cmd(0xd3, 0xd8); expect(r.sound.in8(0x22a)).toBe(0);
    r.cmd(0xf2, 0xf3); expect(r.mixRead(0x82)).toBe(3);
    r.sound.in8(0x22e); expect(r.mixRead(0x82)).toBe(2);
    expect(r.interrupts.at(-1)).toEqual([5, true]);
    r.sound.in8(0x22f); expect(r.mixRead(0x82)).toBe(0);
    expect(r.interrupts.at(-1)).toEqual([5, false]);
    r.sound.validateState();
  });

  it('Windows-style signed 16-bit stereo auto-init has DSP half-buffer IRQs independent of DMA TC and plays refilled halves', () => {
    const r = rig(), address = 0x20000, frame = CLOCK / SOUND_RATE;
    const view = new DataView(r.memory.buffer);
    [0, -32768, 16384, -16384, 32767, -1, -8192, 8192].forEach((v, i) => view.setInt16(address + i * 2, v, true));
    programDma(r.dma, 5, address, 8);
    r.fullVolume();
    r.cmd(0x41, SOUND_RATE >> 8, SOUND_RATE & 255, 0xb6, 0x30, 3, 0);
    r.to(frame * 2 + 1e-6);
    expect(r.mixRead(0x82)).toBe(2);
    expect(r.dma.count[5]).toBe(3);
    expect(r.dma.in8(0xd0) & 2).toBe(0);
    r.sound.in8(0x22e); expect(r.mixRead(0x82)).toBe(2);
    r.sound.in8(0x22f);
    [8192, -8192, 4096, -4096].forEach((v, i) => view.setInt16(address + i * 2, v, true));
    r.to(frame * 4 + 1e-6);
    expect(r.dma.in8(0xd0) & 2).toBe(2);
    expect(r.dma.addr[5]).toBe(address >> 1 & 0xffff);
    expect(r.mixRead(0x82)).toBe(2);
    r.sound.in8(0x22f);
    r.to(frame * 6 + 1e-6);
    r.cmd(0xd5);
    const actual = r.samples();
    expect(actual).toHaveLength(12);
    const expected = [0, -1, .5, -.5, 32767 / 32768, -1 / 32768, -.25, .25, .25, -.25, .125, -.125];
    expected.forEach((v, i) => expect(actual[i]).toBeCloseTo(v, 6));
    expect(r.rates.every(rate => rate === 48000)).toBe(true);
    expect(r.warnings).toEqual([]);
    r.sound.validateState();
  });

  it('pause freezes DMA/block progress; resume continues; exit-auto-init stops at next DSP boundary', () => {
    const r = rig(), frame = CLOCK / 24000;
    programDma(r.dma, 5, 0x1000, 8);
    r.cmd(0x41, 24000 >> 8, 24000 & 255, 0xb6, 0x10, 3, 0);
    r.advance(frame + 1);
    expect(r.dma.count[5]).toBe(6);
    r.cmd(0xd5);
    r.advance(CLOCK);
    expect(r.dma.count[5]).toBe(6);
    expect(r.mixRead(0x82)).toBe(0);
    expect(r.sound.next).toBe(Infinity);
    r.cmd(0xd6, 0xd9);
    r.advance(frame * 3);
    expect(r.mixRead(0x82)).toBe(2);
    expect(r.dma.count[5]).toBe(3);
    r.advance(frame * 2);
    expect(r.sound.next).toBe(Infinity);
    r.sound.validateState();
  });

  it('8-bit unsigned mono keeps a low native sample rate but emits measurable 48000 Hz stereo PCM', () => {
    const r = rig(), rate = 6000;
    r.memory.set([0, 128, 255, 64], 0x1000);
    programDma(r.dma, 1, 0x1000, 4, false);
    r.fullVolume();
    r.cmd(0x41, rate >> 8, rate & 255, 0xc0, 0, 3, 0);
    r.advance(CLOCK / rate * 6);
    const samples = r.samples();
    expect(samples.length).toBeGreaterThanOrEqual(64);
    for (let i = 0; i < 16; i++) expect(samples[i]).toBe(-1);
    expect(samples).toContain(127 / 128);
    expect(samples).toContain(-.5);
    for (let i = 0; i < samples.length; i += 2) expect(samples[i]).toBe(samples[i + 1]);
    expect(r.mixRead(0x82)).toBe(1);
    expect(r.dma.ready(1)).toBe(false);
    expect(r.sound.next).toBe(Infinity);
  });

  it('master/DAC left-right volume and speaker mute affect output without stopping DMA or interrupts', () => {
    const r = rig(), frame = CLOCK / 48000;
    r.memory.fill(192, 0x1000, 0x1100);
    programDma(r.dma, 1, 0x1000, 256);
    r.fullVolume(); r.mixer(0x33, 0);
    r.cmd(0x41, 48000 >> 8, 48000 & 255, 0xc6, 0, 3, 0);
    r.advance(frame * 2 + 1e-6);
    r.cmd(0xd3);
    r.advance(frame * 2);
    r.cmd(0xd0);
    expect(r.samples().slice(0, 4)).toEqual([.5, 0, .5, 0]);
    expect(r.samples().slice(4)).toEqual([0, 0, 0, 0]);
    expect(r.mixRead(0x82)).toBe(1);
    expect(r.dma.count[1]).toBe(251);
    r.mixer(0x22, 0xf8);
    expect(r.mixRead(0x30)).toBe(0xf0);
    expect(r.mixRead(0x31)).toBe(0x80);
  });

  it('reset cancels DMA/rendering and preserves hardware resource selections; rejects unsupported recording and invalid selectors', () => {
    const r = rig();
    r.mixer(0x80, 8); r.mixer(0x81, 0x88);
    r.cmd(0xc6, 0, 3, 0);
    r.sound.out8(0x226, 1); r.sound.out8(0x226, 0); r.advance(CLOCK);
    expect(r.sound.next).toBe(Infinity);
    expect(r.mixRead(0x80)).toBe(8); expect(r.mixRead(0x81)).toBe(0x88);
    r.mixer(0x80, 6); r.mixer(0x81, 0x66);
    expect(r.mixRead(0x80)).toBe(8); expect(r.mixRead(0x81)).toBe(0x88);
    r.cmd(0xbe, 0x30, 3, 0);
    r.sound.out8(0x228, 0x20);
    expect(r.warnings).toHaveLength(4);
    expect(r.sound.next).toBe(Infinity);
    r.sound.validateState();
    r.sound.mixer[0x81] = 0xff;
    expect(() => r.sound.validateState()).toThrow(/Invalid SB16 state: DMA/);
  });

  it('legacy timeconstant/blocksize and unsigned auto-init produce 8-bit IRQs', () => {
    const r = rig();
    programDma(r.dma, 1, 0x1000, 16);
    r.memory.fill(128, 0x1000, 0x1010);
    r.cmd(0x40, 156, 0x48, 3, 0, 0x1c);
    r.advance(CLOCK * 4 / 10000 + 1e-6);
    expect(r.mixRead(0x82)).toBe(1);
    expect(r.dma.count[1]).toBe(11);
    r.sound.in8(0x22e);
    r.cmd(0xda); r.advance(CLOCK * 4 / 10000);
    expect(r.mixRead(0x82)).toBe(1);
    r.advance(CLOCK / 10000 * 2);
    expect(r.sound.next).toBe(Infinity);
  });

  it('programmable IRQ2 is AT IRQ9 and mixer-selected alternate DMA channel transfers signed 8-bit data', () => {
    const r = rig();
    r.mixer(0x80, 1); r.mixer(0x81, 0x28);
    r.memory.set([0x80, 0x7f], 0x1000);
    programDma(r.dma, 3, 0x1000, 2, false);
    r.fullVolume();
    r.cmd(0x41, 48000 >> 8, 48000 & 255, 0xc0, 0x10, 1, 0);
    r.advance(CLOCK / 48000 * 4);
    expect(r.samples().slice(0, 4)).toEqual([-1, -1, 127 / 128, 127 / 128]);
    expect(r.interrupts.at(-1)).toEqual([9, true]);
    expect(r.dma.count[3]).toBe(0xffff);
    r.sound.in8(0x22e);
    expect(r.interrupts.at(-1)).toEqual([9, false]);
  });

  it('unsigned 16-bit mono sample decoding uses a word DMA count and command count, never byte length', () => {
    const r = rig();
    r.memory.set([0, 0, 0, 0x80, 0xff, 0xff], 0x1000);
    programDma(r.dma, 5, 0x1000, 3, false);
    r.fullVolume();
    r.cmd(0x41, 48000 >> 8, 48000 & 255, 0xb0, 0, 2, 0);
    r.advance(CLOCK / 48000 * 5);
    const data = r.samples();
    expect(data.slice(0, 6)).toEqual([-1, -1, 0, 0, 32767 / 32768, 32767 / 32768]);
    expect(r.mixRead(0x82)).toBe(2);
    expect(r.dma.count[5]).toBe(0xffff);
    expect(r.dma.addr[5]).toBe(0x803);
  });

  it('a single-cycle output command switches an auto-init stream at the current block boundary', () => {
    const r = rig(), frame = CLOCK / 48000;
    programDma(r.dma, 5, 0x1000, 16);
    r.cmd(0x41, 48000 >> 8, 48000 & 255, 0xb6, 0x10, 3, 0);
    r.advance(frame * 2);
    r.cmd(0xb0, 0x10, 1, 0);
    r.sound.validateState();
    r.advance(frame * 2 + 1e-6);
    expect(r.dma.count[5]).toBe(11);
    expect(r.mixRead(0x82)).toBe(2);
    r.sound.in8(0x22f);
    r.advance(frame * 2);
    expect(r.dma.count[5]).toBe(9);
    expect(r.mixRead(0x82)).toBe(2);
    r.advance(frame * 2);
    expect(r.sound.next).toBe(Infinity);
    r.sound.validateState();
  });

  it('machine opt-in has no CPU/FPU dependency, schedules HLT with PIT/RTC disabled and stops audio on power-off/load', () => {
    expect(DEFAULT_CONFIG.sound).toBe(false);
    expect(CONFIG_OPTIONS.some(o => o.key === 'sound')).toBe(true);
    const program = assemble('.model tiny\n.code\norg 100h\nstart: sti\nhlt\njmp start\nend start');
    const disabled = new Machine();
    disabled.load(program);
    disabled.cpu.io.out8(0x22c, 0xf2);
    expect(disabled.cpu.io.in8(0x22a)).toBe(0xff);
    expect(disabled.pic.irr & 0x20).toBe(0);
    const m = new Machine({ sound: true, pit: false, rtc: false, fpu: false });
    m.load(program); m.setHistory(false);
    expect(m.cpu.fpu).toBeNull();
    programDma(m.dma, 1, 0x1000, 32);
    for (const b of [0x41, 0xbb, 0x80, 0xc6, 0, 3, 0]) m.cpu.io.out8(0x22c, b);
    m.run(30);
    expect(m.clock).toBeGreaterThan(CLOCK / 48000 * 4);
    expect(m.pic.irr & 0x20).toBe(0x20);
    m.powerOff();
    expect(m.sound.next).toBe(Infinity);
    expect(m.pic.irr & 0x20).toBe(0);
    m.load(program);
    expect(m.sound.next).toBe(Infinity);
    expect(configWarnings({ ...DEFAULT_CONFIG, sound: true, pic: false, dma: false, slavePic: false })
      .filter(w => w.includes('SB16'))).toHaveLength(3);
  });
});

describe('AT 16-bit DMA', () => {
  it.each([5, 6, 7])('channel %i ignores page bit 0, counts words, returns bytes, wraps at 128KiB and auto-reloads', channel => {
    const r = rig();
    programDma(r.dma, channel, 0x3fffe, 2);
    r.memory.set([1, 2], 0x3fffe); r.memory.set([3, 4], 0x20000);
    const data = new Uint8Array(8);
    const result = r.dma.transfer(channel, data, { readLin: a => r.memory[a], writeLin: () => {} });
    expect(result).toEqual({ n: 4, tc: true });
    expect(Array.from(data)).toEqual([1, 2, 3, 4, 0, 0, 0, 0]);
    expect(r.dma.addr[channel]).toBe(0xffff);
    expect(r.dma.count[channel]).toBe(1);
    expect(r.dma.ready(channel)).toBe(true);
    expect(r.dma.in8(0xd0) & 1 << (channel & 3)).not.toBe(0);
    expect(r.dma.in8(0xd0)).toBe(0);
  });

  it('decrements word addresses, refuses partial words/masked/disabled channels and single-cycle masks at TC', () => {
    const r = rig(), mem = { readLin: (a: number) => r.memory[a], writeLin: () => {} };
    programDma(r.dma, 5, 0x20002, 2, false, true);
    r.memory.set([1, 2, 3, 4], 0x20000);
    expect(r.dma.transfer(5, new Uint8Array(1), mem)).toEqual({ n: 0, tc: false });
    const data = new Uint8Array(4);
    expect(r.dma.transfer(5, data, mem)).toEqual({ n: 4, tc: true });
    expect(Array.from(data)).toEqual([3, 4, 1, 2]);
    expect(r.dma.addr[5]).toBe(0xffff);
    expect(r.dma.ready(5)).toBe(false);
    expect(r.dma.transfer(5, data, mem)).toEqual({ n: 0, tc: false });
    r.dma.out8(0xd4, 1); r.dma.out8(0xd0, 4);
    expect(r.dma.ready(5)).toBe(false);
    expect(r.dma.transfer(5, data, mem)).toEqual({ n: 0, tc: false });
    expect(r.dma.ready(4)).toBe(false);
  });
});
