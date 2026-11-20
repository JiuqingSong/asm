import { describe, it, expect, vi } from 'vitest';
import { assemble } from '../src/asm/assembler.ts';
import { AX, CS } from '../src/cpu/cpu.ts';
import { Machine } from '../src/machine/machine.ts';
import { DualMachine } from '../src/machine/dual.ts';
import { saveSnapshot, loadSnapshot, type SnapshotWorkspace } from '../src/machine/snapshot.ts';
import { Disk, blankFloppy, blankHardDisk } from '../src/machine/disk.ts';
import { BlobSource, BytesSource, IsoDisk } from '../src/machine/iso.ts';
import { buildIso } from '../tools/mkiso.ts';

const workspace = (): SnapshotWorkspace => ({
  sessions: [0, 1].map(i => ({
    source: `source ${i}`, fileName: `test${i}.asm`, cmdline: '/a', binary: null,
    binaryText: null, dirty: true, sourceModified: false, addrBps: [123], sourceBps: [2], record: true,
  })), active: 1, speed: '386', showDiskImages: true,
});
function make(fpu = false): DualMachine {
  return new DualMachine('full', [new Machine({ fpu }), new Machine()]);
}
function packet(m: Machine, bytes: number[]): void {
  m.cdrom.out8(0x177, 0xa0);
  for (let i = 0; i < 12; i += 2) m.cdrom.out16((bytes[i] ?? 0) | ((bytes[i + 1] ?? 0) << 8));
}

describe('persistent VM snapshots', () => {
  it('freezes RTC/BIOS/DOS calendar time across offline elapsed time and advances only by virtual clocks', async () => {
    const epoch = Date.UTC(2020, 3, 4, 12, 34, 57);
    const wall = vi.spyOn(Date, 'now').mockReturnValue(epoch);
    try {
      const d = make();
      d.m[0].clock = 123.5;
      const saved = await saveSnapshot(d, 'debug', workspace());
      wall.mockReturnValue(epoch + 7 * 86400_000);
      const r = (await loadSnapshot(saved)).dual.m[0];
      expect(r.now()).toBe(epoch);
      expect(d.m[0].now()).toBe(epoch + 7 * 86400_000);
      r.cpu.io.out8(0x70, 0);
      expect(r.cpu.io.in8(0x71)).toBe(0x57);
      r.clock += 1193182;
      expect(r.now()).toBe(epoch + 1000);
      expect(r.cpu.io.in8(0x71)).toBe(0x58);
      r.cpu.r[AX] = 0x0200; r.hle.handle(0x1a);
      expect(r.cpu.r[2] >> 8).toBe(0x58); // BIOS DH: BCD seconds
      r.cpu.r[AX] = 0x2c00; r.hle.handle(0x21);
      expect(r.cpu.r[2] >> 8).toBe(58); // DOS DH: binary seconds
    } finally { wall.mockRestore(); }
  });

  it('continues 32-bit protected execution with hidden segment and stale paging/fetch caches intact', async () => {
    const d = make(), m = d.m[0];
    m.setCpu('386');
    const cpu = m.cpu;
    cpu.setA20(true);
    cpu.msw = 0x80000001;
    cpu.flags = 2;
    cpu.s[CS] = 8;
    cpu.cBase[CS] = 0x2000;
    cpu.cBig[CS] = 1;
    cpu.cLimit[CS] = 0xffffffff;
    cpu.ip = 0;
    cpu.mem.set([0xb8, 0x78, 0x56, 0x34, 0x12, 0x40, 0xf4], 0x5000);
    // No valid page tables remain: the cached translation is architectural until
    // the guest invalidates it, so flushing caches during restore would fault.
    const privateCpu = cpu as unknown as { tlb: Int32Array; tlbUsed: Int32Array; tlbCount: number };
    privateCpu.tlb[2] = 0x5007;
    privateCpu.tlbUsed[0] = 2;
    privateCpu.tlbCount = 1;
    cpu.step();
    expect(cpu.r32(AX)).toBe(0x12345678);
    const restored = (await loadSnapshot(await saveSnapshot(d, 'full', workspace()))).dual.m[0].cpu;
    expect(restored.protectedMode).toBe(true);
    expect(restored.msw).toBe(cpu.msw);
    expect(restored.cBase[CS]).toBe(0x2000);
    expect(restored.cBig[CS]).toBe(1);
    expect((restored as unknown as typeof privateCpu).tlb[2]).toBe(0x5007);
    restored.step();
    expect(restored.r32(AX)).toBe(0x12345679);
    expect(cpu.r32(AX)).toBe(0x12345678);
  });

  it('captures synchronously, restores paused with fresh callbacks, CPU caches, exact FPU, mapping and History', async () => {
    const d = make(true), m = d.m[0];
    m.load(assemble('.model tiny\n.code\norg 100h\nstart: mov ax, 1\ninc ax\ninc ax\nhlt\nend start'));
    m.setCpu('386');
    m.stepInto();
    m.clock = 2345.75; m.status = 'running';
    m.cpu.fpu!.registers[0] = 0x7fff8000000000001234n;
    m.cpu.fpu!.tags[0] = 2;
    // Unreal/protected hidden state must survive without reloading descriptors.
    const cpu = m.cpu as unknown as Record<string, unknown>;
    cpu.overrideMask = 1 << CS;
    m.cpu.cBase[CS] = m.cpu.s[CS] * 16;
    cpu.inhibitIrq = true;
    const savedProgram = m.program, savedIP = m.cpu.ip;
    const promise = saveSnapshot(d, 'debug', workspace());
    m.cpu.r[AX] = 100; m.mem[0x999] = 99; m.clock = 9000;
    const restored = await loadSnapshot(await promise), r = restored.dual.m[0];
    expect(restored.mode).toBe('debug');
    expect(restored.workspace).toEqual(workspace());
    expect(r.status).toBe('paused');
    expect(r.cpu.r[AX]).toBe(1);
    expect(r.cpu.ip).toBe(savedIP);
    expect(r.clock).toBe(2345.75);
    expect(r.mem[0x999]).toBe(0);
    expect(r.program).toEqual(savedProgram);
    expect((r.cpu as unknown as Record<string, unknown>).inhibitIrq).toBe(true);
    expect((r.cpu as unknown as Record<string, unknown>).overrideMask).toBe(1 << CS);
    expect(r.cpu.fpu!.registers[0]).toBe(0x7fff8000000000001234n);
    expect(r.cpu.trap).not.toBe(m.cpu.trap);
    expect(r.cpu.io).not.toBe(m.cpu.io);
    expect(r.cpu.onWrite).not.toBe(m.cpu.onWrite);
    const oldPic = m.pic.irr;
    r.cpu.io.out8(0x21, 0); r.pic.raise(1);
    expect(m.pic.irr).toBe(oldPic);
    r.stepInto();
    expect(r.cpu.r[AX]).toBe(2);
    r.stepBack();
    expect(r.cpu.r[AX]).toBe(1);
    expect(r.history.count).toBe(1);
  });

  it('preserves halted/waiting CPU, DOS open handles and pending logical disk latency', async () => {
    const d = make(), m = d.m[0];
    m.diskLatency = false;
    const p = assemble(`.model tiny
.code
org 100h
start: mov dx, offset filename
mov ax, 3d00h
int 21h
mov bx, ax
mov cx, 2
mov dx, offset buffer
mov ah, 3fh
int 21h
mov ah, 3fh
int 21h
hlt
filename db 'A.TXT',0
buffer db 4 dup(0)
end start`);
    m.load(p);
    m.files.set('A.TXT', new TextEncoder().encode('abcd'));
    for (let i = 0; i < 200; i++) {
      m.stepInto();
      const handles = (m.hle as unknown as { handles: Map<number, { pos: number }> }).handles;
      if (Array.from(handles.values()).some(h => h.pos === 2)) break;
    }
    const handles = (m.hle as unknown as { handles: Map<number, { pos: number }> }).handles;
    expect(Array.from(handles.values()).some(h => h.pos === 2)).toBe(true);
    m.status = 'waiting'; m.cpu.waiting = true; m.cpu.halted = true;
    (m.hle as unknown as { busyUntil: number }).busyUntil = m.clock + 456;
    const r = (await loadSnapshot(await saveSnapshot(d, 'full', workspace()))).dual.m[0];
    expect(r.status).toBe('paused'); expect(r.cpu.waiting).toBe(true); expect(r.cpu.halted).toBe(true);
    expect(r.hle.busyRemaining()).toBe(456);
    const restoredHandles = (r.hle as unknown as { handles: Map<number, { pos: number }> }).handles;
    expect(restoredHandles).toEqual(handles);
    r.cpu.waiting = false; r.cpu.halted = false;
    for (let i = 0; i < 200 && !r.cpu.halted; i++) r.stepInto();
    expect(Array.from(restoredHandles.values()).some(h => h.pos === 4)).toBe(true);
    expect(Array.from(handles.values()).some(h => h.pos === 2)).toBe(true);
  });

  it('includes every raw medium, lazy Blob ISO and generated HDD without external files', async () => {
    const d = make(), m = d.m[0];
    m.drives[0] = new Disk('floppy.img', blankFloppy(), true);
    m.drives[2] = new Disk('hdd.img', blankHardDisk(1), false);
    m.drives[0].data[12345] = 123; m.drives[2].data[23456] = 234;
    const isoBytes = buildIso([{ path: 'DATA.BIN', data: new Uint8Array(150_000).fill(71) }], 'SNAPSHOT');
    const isoBlob = new Blob([isoBytes.slice()]);
    const src = new BlobSource(isoBlob);
    const iso = await IsoDisk.open(src, 'CD.ISO');
    m.drives[3] = new Disk('CD.ISO', new Uint8Array(), false, iso);
    m.drives[3].isoFile = isoBlob;
    m.cdrom.insert(src, 'CD.ISO');
    m.cdBoot = m.drives[0];
    m.cdBootNoEmu = { image: Uint8Array.of(1, 2, 3), loadSeg: 0x700, rba: 2, count: 1 };
    const previousFont = Machine.font;
    try {
      Machine.font = new Uint8Array(2048).fill(42);
      const saved = await saveSnapshot(d, 'dual', workspace());
      Machine.font = null;
      const r = (await loadSnapshot(saved)).dual.m[0];
      expect(Machine.font![1]).toBe(42);
      expect(r.drives[0]!.data[12345]).toBe(123);
      expect(r.drives[2]!.data[23456]).toBe(234);
      expect(r.cdBoot).toBe(r.drives[0]);
      expect(r.cdBootNoEmu!.image).toEqual(Uint8Array.of(1, 2, 3));
      expect(r.cdrom.source).toBeInstanceOf(BlobSource);
      expect(new Uint8Array(await r.drives[3]!.isoFile!.arrayBuffer())).toEqual(isoBytes);
      await r.cdrom.source!.load(0, isoBytes.length);
      expect(r.cdrom.source!.get(0, isoBytes.length)).toEqual(isoBytes);
      const ref = await IsoDisk.open(new BytesSource(isoBytes), 'CD.ISO');
      for (const lba of [0, 63, 100, ref.sectorCount - 1]) expect(r.drives[3]!.readSector(lba)).toEqual(ref.readSector(lba));
    } finally { Machine.font = previousFont; }
  });

  it('continues delayed IDE, partial FDC PIO, asynchronous ATAPI, and null-modem inflight transfers without time advancement', async () => {
    const d = make(), m = d.m[0], other = d.m[1];
    m.drives[2] = new Disk('hdd', blankHardDisk(1), false);
    m.drives[2].data[0] = 0x12; m.drives[2].data[1] = 0x34;
    m.ide.out8(0x1f6, 0xe0); m.ide.out8(0x1f2, 1); m.ide.out8(0x1f3, 0); m.ide.out8(0x1f7, 0x20);
    m.drives[0] = new Disk('floppy', blankFloppy(), true);
    m.drives[0].data.fill(0x57, 0, 512);
    for (const v of [3, 0, 1]) m.fdc.out8(0x3f5, v);
    for (const v of [0x46, 0, 0, 0, 1, 2, 1, 0, 0]) m.fdc.out8(0x3f5, v);
    m.clock = 600; m.fdc.tick(); m.ide.tick();
    other.drives[0] = new Disk('other-floppy', blankFloppy(), true);
    other.drives[0].data.fill(0x74, 0, 512);
    for (const v of [0x46, 0, 0, 0, 1, 2, 1, 0, 0]) other.fdc.out8(0x3f5, v);
    other.clock = 600; other.fdc.tick(); // DMA is masked: retain the per-sector continuation.
    expect(m.fdc.in8(0x3f5)).toBe(0x57);
    m.ide.in16();
    m.ide.out8(0x1f7, 0xec); // delayed identify, with its captured 512-byte result
    const source = new BlobSource(new Blob([new Uint8Array(2048).fill(0x63)]));
    m.cdrom.insert(source, 'RAW.ISO'); packet(m, [0]); // clear media-changed sense
    packet(m, [0x28, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(m.cdrom.in8(0x376) & 0x80).toBe(0x80);
    d.link.transmit(m.com1, 0x41, 800);
    const clock = m.clock, otherClock = other.clock, next = m.ide.next;
    const r = (await loadSnapshot(await saveSnapshot(d, 'dual', workspace()))).dual;
    expect(r.m[0].clock).toBe(clock); expect(r.m[1].clock).toBe(otherClock);
    expect(r.m[0].ide.next).toBe(next);
    expect(r.m[0].ide.in16()).toBe(0xffff);
    r.m[0].clock = next; r.m[0].ide.tick();
    expect(r.m[0].ide.in16()).toBe(0x40);
    for (let i = 1; i < 512; i++) expect(r.m[0].fdc.in8(0x3f5)).toBe(0x57);
    expect(r.m[0].fdc.in8(0x3f4) & 0x40).toBe(0x40);
    r.m[1].dma.addr[2] = 0x4000; r.m[1].dma.count[2] = 511; r.m[1].dma.mode[2] = 0x46;
    r.m[1].dma.mask &= ~4;
    r.m[1].clock = r.m[1].fdc.next; r.m[1].fdc.tick();
    expect(r.m[1].mem.subarray(0x4000, 0x4200)).toEqual(new Uint8Array(512).fill(0x74));
    expect(other.mem[0x4000]).toBe(0);
    await r.m[0].cdrom.source!.load(0, 2048);
    await Promise.resolve(); r.m[0].cdrom.poll();
    expect(r.m[0].cdrom.in16()).toBe(0x6363);
    r.link.deliver(r.m[1].com1, 800);
    expect(r.m[1].com1.in8(0)).toBe(0x41);
    expect(other.com1.stats.rxBytes).toBe(0);
  });

  it('rejects unsupported versions, truncation, corruption and malformed graph metadata', async () => {
    const saved = await saveSnapshot(make(), 'debug', workspace());
    const version = new Uint8Array(await saved.slice(0, 56).arrayBuffer());
    new DataView(version.buffer).setUint32(8, 2, true);
    await expect(loadSnapshot(new Blob([version, saved.slice(56)]))).rejects.toThrow(/unsupported version/);
    await expect(loadSnapshot(saved.slice(0, 30))).rejects.toThrow(/truncated/);
    await expect(loadSnapshot(saved.slice(0, saved.size - 1))).rejects.toThrow(/length/);
    const tail = new Uint8Array(await saved.slice(-1).arrayBuffer()); tail[0] ^= 1;
    await expect(loadSnapshot(new Blob([saved.slice(0, -1), tail]))).rejects.toThrow(/integrity/);
    const header = new Uint8Array(await saved.slice(0, 56).arrayBuffer()), dv = new DataView(header.buffer);
    const oldLength = dv.getUint32(12, true);
    const manifest = JSON.parse(await saved.slice(56, 56 + oldLength).text());
    manifest.nodes[0].p.push(['__proto__', null]);
    const metadata = new TextEncoder().encode(JSON.stringify(manifest));
    header.set(new Uint8Array(await crypto.subtle.digest('SHA-256', metadata)), 24);
    dv.setUint32(12, metadata.length, true);
    dv.setFloat64(16, saved.size - oldLength + metadata.length, true);
    await expect(loadSnapshot(new Blob([header, metadata, saved.slice(56 + oldLength)]))).rejects.toThrow(/properties/);
  });
});
