import { CPU } from '../cpu/cpu.ts';
import { X87 } from '../cpu/x87.ts';
import { Machine, History } from './machine.ts';
import { DualMachine } from './dual.ts';
import { DEFAULT_CONFIG, type StartupMode, type MachineConfig } from './config.ts';
import { PIC, PIT, DMA, Keyboard } from './devices.ts';
import { Hle } from './bios.ts';
import { DosMemory } from './dosmem.ts';
import { UART, NullModem } from './uart.ts';
import { Mouse } from './mouse.ts';
import { SerialMouse } from './serial-mouse.ts';
import { Video, Planar } from './video.ts';
import { Disk } from './disk.ts';
import { IsoDisk, BlobSource, BytesSource } from './iso.ts';
import { FatVolume } from './fat.ts';
import { AtapiCdrom } from './atapi.ts';
import { IdeChannel } from './ide.ts';
import { FloppyController } from './fdc.ts';
import { SoundBlaster } from './sound.ts';
import { sha256 } from '@noble/hashes/sha2.js';

export interface SnapshotSession {
  source: string; fileName: string; cmdline: string; binary: string | null;
  binaryText: string | null; dirty: boolean; sourceModified: boolean;
  addrBps: number[]; sourceBps: number[]; record: boolean;
}
export interface SnapshotWorkspace {
  sessions: SnapshotSession[];
  active: number; speed: string; showDiskImages: boolean;
  chinese?: boolean; showBytes?: boolean; fullscreenCapture?: boolean;
  /** 是否启用 D: 盘（旧快照没有这一项，按启用处理） */
  driveD?: boolean;
}
export interface LoadedSnapshot { dual: DualMachine; mode: StartupMode; workspace: SnapshotWorkspace }

// Format and implementation schema deliberately move together: private CPU/device
// fields are part of this schema, not a portable register-only interchange format.
const VERSION = 2;
const MAGIC = new TextEncoder().encode('ASM86VM\0');
const HEADER = 56;
const MAX_META = 32 * 1024 * 1024;
const MAX_NODES = 500_000;
type Value = null | boolean | string | number | { r: number } | { n: string } | { b: string } | { u: true };
interface Node { t: string; p?: [string, Value][]; v?: Value[]; e?: [Value, Value][]; block?: number; parts?: number[]; offset?: number; length?: number; mime?: string }
interface Manifest { schema: number; root: Value; nodes: Node[]; blocks: { size: number; storedSize: number; encoding: 'raw' | 'gzip'; hash: string }[]; anchors: [number, number, string][]; configs: MachineConfig[] }
type AnyObject = Record<string, unknown>;
const classes = {
  DualMachine, Machine, CPU, X87, History, PIC, PIT, DMA, Keyboard, Hle, DosMemory,
  UART, NullModem, Mouse, SerialMouse, Video, Planar, Disk, IsoDisk, BlobSource,
  BytesSource, FatVolume, AtapiCdrom, IdeChannel, FloppyController, SoundBlaster,
};
const TYPE = Symbol.for('asm86.snapshot.type.v1');
for (const [name, ctor] of Object.entries(classes)) {
  if (!Object.hasOwn(ctor.prototype, TYPE)) Object.defineProperty(ctor.prototype, TYPE, { value: name });
}
const runtime: Record<string, string[]> = {
  Machine: ['events'], CPU: ['io', 'irq', 'trap', 'onWrite', 'mmio', 'onFpuIrq', 'onUnsupported', 'onShutdown'],
  X87: ['onChange', 'onError'], PIC: ['onChange'], PIT: ['onTick', 'onReload'],
  UART: ['now', 'setIrq', 'onActivity', 'onWarn'], Mouse: ['onChange'],
  Video: ['onMapChange'], Planar: ['onWrite'], BlobSource: ['pending'],
  AtapiCdrom: ['raiseIrq', 'lowerIrq', 'onChange'], IdeChannel: ['host'], FloppyController: ['host'],
  SoundBlaster: ['host'],
};
const specialFields: Record<string, string[]> = {
  Disk: ['data', 'geo', 'floppy', 'floppyType', 'name', 'dirty', 'changed', 'iso', 'isoFile'],
  IsoDisk: ['sectorCount', 'geo', 'description', 'iso', 'spc', 'fatSectors', 'rootEntries', 'clusters', 'usedEnd', 'extents', 'rootDir', 'bootSector', 'mbr', 'PART', 'fatStart', 'rootStart', 'dataStart', 'partSectors'],
  FatVolume: ['data', 'base', 'fat16', 'bps', 'spc', 'fatStart', 'fatSectors', 'fats', 'rootStart', 'rootEntries', 'dataStart', 'clusters', 'label'],
  BlobSource: ['chunks', 'blob', 'reported'], BytesSource: ['bytes'],
};
const views = { Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView };
function className(obj: object): string | undefined {
  const prototype = Object.getPrototypeOf(obj) as object | null;
  const name: unknown = prototype && Object.getOwnPropertyDescriptor(prototype, TYPE)?.value;
  return typeof name === 'string' && Object.hasOwn(classes, name) ? name : undefined;
}
const fail = (message: string): never => { throw new Error(`Invalid VM snapshot: ${message}`); };
const safeKey = (key: string) => key !== '__proto__' && key !== 'prototype' && key !== 'constructor';
const integer = (n: unknown, max = Number.MAX_SAFE_INTEGER): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= max;
async function hash(bytes: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  const digest = subtle ? new Uint8Array(await subtle.digest('SHA-256', bytes)) : sha256(new Uint8Array(bytes));
  return Array.from(digest, v => v.toString(16).padStart(2, '0')).join('');
}
function modeValid(mode: unknown): mode is StartupMode { return mode === 'debug' || mode === 'dual' || mode === 'full'; }
function configValid(config: unknown): config is MachineConfig {
  return !!config && typeof config === 'object' && Object.keys(config).length === Object.keys(DEFAULT_CONFIG).length &&
    Object.keys(DEFAULT_CONFIG).every(k => typeof (config as AnyObject)[k] === 'boolean');
}
function legacyConfigValid(config: unknown): boolean {
  const keys = Object.keys(DEFAULT_CONFIG).filter(k => k !== 'sound');
  return !!config && typeof config === 'object' && Object.keys(config).length === keys.length &&
    keys.every(k => typeof (config as AnyObject)[k] === 'boolean');
}
function workspaceValid(w: unknown): w is SnapshotWorkspace {
  if (!w || typeof w !== 'object') return false;
  const a = w as SnapshotWorkspace;
  return Array.isArray(a.sessions) && a.sessions.length === 2 && integer(a.active, 1) && typeof a.speed === 'string' &&
    typeof a.showDiskImages === 'boolean' && [a.chinese, a.showBytes, a.fullscreenCapture, a.driveD].every(v => v === undefined || typeof v === 'boolean') &&
    a.sessions.every(s => s && ['source', 'fileName', 'cmdline'].every(k => typeof (s as unknown as AnyObject)[k] === 'string') &&
      [s.binary, s.binaryText].every(v => v === null || typeof v === 'string') &&
      [s.dirty, s.sourceModified, s.record].every(v => typeof v === 'boolean') &&
      [s.addrBps, s.sourceBps].every(v => Array.isArray(v) && v.every(n => integer(n, 0xffffffff))));
}
const anchorPaths = ['cpu', 'pic', 'pic2', 'dma', 'cdrom', 'ide', 'fdc', 'sound', 'kbd', 'pit', 'com1', 'com2', 'hle', 'dosmem', 'video', 'video.planar', 'mouse', 'serialMouse', 'history', 'cpu.fpu'];
function at(m: Machine, path: string): unknown {
  return path.split('.').reduce<unknown>((a, k) => (a as AnyObject)[k], m);
}
function fields(type: string, seed: object): string[] {
  return (specialFields[type] ?? Object.keys(seed)).filter(k => !runtime[type]?.includes(k)).sort();
}
function validatePersistentState(machine: Machine): void {
  machine.sound.validateState();
  const cpu = machine.cpu as unknown as AnyObject;
  if (!['empty', 'ready', 'paused', 'running', 'waiting', 'exited', 'error'].includes(machine.status) ||
      !['8088', '286', '386', '486'].includes(machine.cpuModel) || !Number.isFinite(machine.clock) || machine.clock < 0 ||
      !Number.isFinite(machine.clocksPerInstr) || machine.clocksPerInstr <= 0 || !integer(cpu.model, 2) ||
      !integer(machine.cpu.ip, 0xffffffff) || !integer(machine.cpu.cpl, 3)) fail('invalid CPU/timing state');
  if (typeof machine.rtcEpoch !== 'number' || !Number.isFinite(machine.rtcEpoch) || Math.abs(machine.rtcEpoch) > 8.64e15 ||
      !Number.isFinite(machine.rtcClock) || machine.rtcClock < 0 || !Number.isInteger(machine.rtcTimezone) || Math.abs(machine.rtcTimezone) > 1440) fail('invalid RTC epoch');
  const history = machine.history as unknown as AnyObject;
  if (history.cap !== 200_000 || history.wcap !== 1 << 22 || !integer(history.count, history.cap as number) ||
      !integer(history.head) || (history.head as number) < (history.count as number) ||
      !integer(history.pos, (history.cap as number) - 1) || !integer(history.wpos)) fail('invalid History ring');
  for (const key of ['gdtr', 'idtr', 'ldtr', 'tr']) {
    const table = cpu[key] as AnyObject;
    if (!table || !integer(table.base, 0xffffffff) || !integer(table.limit, 0xffffffff)) fail('invalid descriptor table');
  }
  const fpu = machine.cpu.fpu;
  if ((machine.config.fpu && !(fpu instanceof X87)) || (!machine.config.fpu && fpu !== null) ||
      (fpu && (!Array.isArray(fpu.registers) || fpu.registers.length !== 8 || fpu.registers.some(v => typeof v !== 'bigint' || v < 0n || v >= 1n << 80n) ||
        !integer(fpu.top, 7)))) fail('invalid FPU state');
  if (!(machine.files instanceof Map) || Array.from(machine.files).some(([k, v]) => typeof k !== 'string' || !(v instanceof Uint8Array))) fail('invalid DOS files');
  const handles = (machine.hle as unknown as { handles: Map<number, AnyObject> }).handles;
  if (!(handles instanceof Map) || Array.from(handles).some(([k, f]) => !integer(k, 20) || k < 5 || !f ||
      typeof f.name !== 'string' || !integer(f.pos) || !Array.isArray(f.data) || !f.data.every(v => integer(v, 255)) ||
      typeof f.write !== 'boolean' || typeof f.dirty !== 'boolean')) fail('invalid DOS handles');
  const ide = machine.ide as unknown as AnyObject, cd = machine.cdrom as unknown as AnyObject, fdc = machine.fdc as unknown as AnyObject;
  const position = (device: AnyObject, buffer: string, pos: string) => device[buffer] instanceof Uint8Array && integer(device[pos], (device[buffer] as Uint8Array).length);
  if (!['idle', 'dataIn', 'dataOut'].includes(ide.phase as string) || !position(ide, 'buf', 'pos') || !integer(ide.unit, 1) ||
      !(ide.waiting === null || ide.waiting instanceof Disk)) fail('invalid IDE state');
  if (!['idle', 'packet', 'dataIn', 'busy'].includes(cd.phase as string) || !position(cd, 'buf', 'pos') || !integer(cd.packetPos, 12) ||
      typeof cd.waiting !== 'boolean' || typeof cd.loading !== 'boolean') fail('invalid ATAPI state');
  if (!['command', 'exec', 'pioIn', 'pioOut', 'result'].includes(fdc.phase as string) || !position(fdc, 'pio', 'pioPos')) fail('invalid FDC state');
  const command = (c: unknown, length: number) => Array.isArray(c) && c.length === length && c.every(v => integer(v, 255));
  for (const a of [ide.action] as (AnyObject | null)[]) {
    if (a && (!['status', 'input', 'write'].includes(a.kind as string) || !integer(a.unit, 1) ||
      (a.kind === 'input' && (!(a.buf instanceof Uint8Array) || (a.count !== undefined && !integer(a.count, 16)))))) fail('invalid IDE continuation');
  }
  for (const a of [fdc.action, fdc.pioDone] as (AnyObject | null)[]) {
    if (!a) continue;
    if (typeof a !== 'object' || !['irq', 'seek', 'id', 'transfer', 'format', 'dma', 'pio', 'formatIds'].includes(a.kind as string)) fail('invalid FDC continuation');
    if (['id', 'transfer', 'format', 'formatIds'].includes(a.kind as string) && !(a.disk instanceof Disk)) fail('invalid continuation medium');
    if (a.kind === 'transfer' && !command(a.c, 9) || a.kind === 'format' && !command(a.c, 6)) fail('invalid continuation command');
    if (['seek', 'id', 'formatIds'].includes(a.kind as string) && (!integer(a.d, 3) || !integer(a.head, 1))) fail('invalid continuation drive');
    if (a.kind === 'seek' && !integer(a.target, 255)) fail('invalid seek target');
    if (a.kind === 'dma' || a.kind === 'pio') {
      const t = a.transfer as AnyObject;
      if (!t || !(t.disk instanceof Disk) || !command(t.c, 9) || !Array.isArray(t.sectors) || t.sectors.length > 512 ||
          !integer(t.usable, t.sectors.length) || !integer(t.k, t.usable as number) ||
          t.sectors.some(x => !x || !Number.isInteger(x.lba) || x.lba < -1 || !integer(x.h, 1) || !integer(x.r, 255))) fail('invalid sector continuation');
    }
  }
  if (machine.program && (!(machine.program.addrToLine instanceof Map) || !(machine.program.lineToAddrs instanceof Map) ||
      !Array.isArray(machine.program.listing))) fail('invalid debugging mapping');
}
function registry(dual: DualMachine): Map<string, { prototype: object; fields: string[]; seed: object }> {
  const seeds = new Map<string, object>();
  seeds.set('DualMachine', dual); seeds.set('NullModem', dual.link); seeds.set('Machine', dual.m[0]);
  for (const path of anchorPaths) {
    const seed = at(dual.m[0], path);
    if (seed) seeds.set(className(seed as object)!, seed as object);
  }
  seeds.set('X87', dual.m.find(m => m.cpu.fpu)?.cpu.fpu ?? new X87());
  seeds.set('BlobSource', new BlobSource(new Blob())); seeds.set('BytesSource', new BytesSource(new Uint8Array()));
  return new Map(Object.entries(classes).map(([name, ctor]) => {
    const seed = seeds.get(name) ?? Object.create(ctor.prototype) as object;
    return [name, { prototype: ctor.prototype, fields: fields(name, seed), seed: { ...seed } }];
  }));
}

/** Captures every mutable byte synchronously before starting any host I/O. */
export async function saveSnapshot(dual: DualMachine, mode: StartupMode, workspace: SnapshotWorkspace): Promise<Blob> {
  if (!modeValid(mode) || !workspaceValid(workspace)) fail('invalid workspace or startup mode');
  const reg = registry(dual), ids = new Map<object, number>(), nodes: Node[] = [], blocks: Blob[] = [], compressible: boolean[] = [];
  const wallEpoch = Date.now(), wallTimezone = new Date(wallEpoch).getTimezoneOffset();
  const block = (b: Blob, compress = false) => { blocks.push(b); compressible.push(compress); return blocks.length - 1; };
  const encode = (v: unknown): Value => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : { n: String(v) };
    if (typeof v === 'bigint') return { b: String(v) };
    if (v === undefined) return { u: true };
    if (typeof v !== 'object') fail('unregistered runtime function');
    const obj = v as object;
    if (ids.has(obj)) return { r: ids.get(obj)! };
    const id = nodes.length; ids.set(obj, id);
    const n: Node = { t: '' }; nodes.push(n);
    if (nodes.length > MAX_NODES) fail('too many objects');
    if (obj instanceof Blob) {
      n.t = 'Blob'; n.parts = []; n.mime = obj.type;
      for (let offset = 0; offset < obj.size; offset += 8 * 1024 * 1024) n.parts.push(block(obj.slice(offset, offset + 8 * 1024 * 1024)));
    }
    else if (obj instanceof ArrayBuffer) { n.t = 'ArrayBuffer'; n.block = block(new Blob([obj.slice(0)]), true); }
    else if (ArrayBuffer.isView(obj)) {
      n.t = obj.constructor.name;
      if (!(n.t in views)) fail('unsupported binary view');
      n.v = [encode(obj.buffer)]; n.offset = obj.byteOffset; n.length = obj.byteLength;
    } else if (Array.isArray(obj)) {
      if (obj.length > 1024 && Object.keys(obj).length === obj.length && obj.every(v => typeof v === 'number')) {
        n.t = 'NumberArray'; n.length = obj.length;
        n.block = block(new Blob([new Float64Array(obj).buffer]), true);
      } else { n.t = 'Array'; n.v = obj.map(encode); }
    }
    else if (obj instanceof Map) { n.t = 'Map'; n.e = Array.from(obj, ([k, val]) => [encode(k), encode(val)]); }
    else if (obj instanceof Set) { n.t = 'Set'; n.v = Array.from(obj, encode); }
    else if (obj instanceof Date) { n.t = 'Date'; n.v = [encode(obj.getTime())]; }
    else {
      const name = className(obj);
      const entry = name ? [name, reg.get(name)!] as const : undefined;
      n.t = entry?.[0] ?? 'Object';
      if (!entry && Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) fail(`unregistered object type (${obj.constructor?.name ?? 'unknown'})`);
      const keys = Object.keys(obj).filter(k => !runtime[n.t]?.includes(k)).sort();
      if (entry && JSON.stringify(keys) !== JSON.stringify(entry[1].fields)) fail(`implementation schema changed (${n.t})`);
      n.p = keys.map(k => {
        if (!safeKey(k)) fail('unsafe property');
        let value = (obj as AnyObject)[k];
        if (n.t === 'Machine' && (obj as Machine).rtcEpoch === null) {
          if (k === 'rtcEpoch') value = wallEpoch;
          if (k === 'rtcClock') value = (obj as Machine).clock;
          if (k === 'rtcTimezone') value = wallTimezone;
        }
        return [k, encode(value)];
      });
    }
    return { r: id };
  };
  const root = encode({ dual, mode, workspace, font: Machine.font });
  const anchors: Manifest['anchors'] = [];
  dual.m.forEach((m, i) => {
    anchors.push([ids.get(m)!, i, '']);
    for (const path of anchorPaths) { const o = at(m, path); if (o) anchors.push([ids.get(o as object)!, i, path]); }
  });
  anchors.push([ids.get(dual)!, -1, 'dual'], [ids.get(dual.link)!, -1, 'link']);
  const configs = dual.m.map(m => ({ ...m.config }));
  const manifest: Manifest = { schema: VERSION, root, nodes, anchors, configs, blocks: [] };
  // Blobs are immutable; typed-array buffers were copied above, so live VM changes
  // and asynchronous media completions can no longer affect this capture.
  // Compress buffers sequentially to bound additional host memory. Media Blobs
  // stay as slices, so restored ISO reads remain lazy and self-contained.
  for (let i = 0; i < blocks.length; i++) {
    const original = blocks[i];
    let encoding: 'raw' | 'gzip' = 'raw';
    if (compressible[i] && original.size >= 65536 && typeof CompressionStream !== 'undefined') {
      const compressed = await new Response(original.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (compressed.size < original.size) { blocks[i] = compressed; encoding = 'gzip'; }
    }
    manifest.blocks.push({ size: original.size, storedSize: blocks[i].size, encoding, hash: await hash(await blocks[i].arrayBuffer()) });
  }
  const metadata = new TextEncoder().encode(JSON.stringify(manifest));
  if (metadata.length > MAX_META) fail('metadata too large');
  const h = new ArrayBuffer(HEADER), dv = new DataView(h), hb = new Uint8Array(h);
  hb.set(MAGIC); dv.setUint32(8, VERSION, true); dv.setUint32(12, metadata.length, true);
  dv.setFloat64(16, HEADER + metadata.length + blocks.reduce((n, b) => n + b.size, 0), true);
  hb.set(Uint8Array.from((await hash(metadata.buffer)).match(/../g)!, x => parseInt(x, 16)), 24);
  return new Blob([h, metadata, ...blocks], { type: 'application/x-asm86-snapshot' });
}

export async function loadSnapshot(blob: Blob): Promise<LoadedSnapshot> {
  if (!(blob instanceof Blob) || blob.size < HEADER) fail('truncated header');
  const h = await blob.slice(0, HEADER).arrayBuffer(), dv = new DataView(h), hb = new Uint8Array(h);
  if (!MAGIC.every((v, i) => hb[i] === v)) fail('invalid magic');
  const version = dv.getUint32(8, true);
  if (version !== VERSION && version !== 1) fail('unsupported version');
  const legacy = version === 1;
  const length = dv.getUint32(12, true);
  if (!length || length > MAX_META || HEADER + length > blob.size || dv.getFloat64(16, true) !== blob.size) fail('truncated or invalid length');
  const metadata = await blob.slice(HEADER, HEADER + length).arrayBuffer();
  if (await hash(metadata) !== Array.from(hb.subarray(24), v => v.toString(16).padStart(2, '0')).join('')) fail('metadata integrity mismatch');
  let m: Manifest;
  try { m = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)) as Manifest; } catch { fail('malformed metadata'); }
  if (!m! || m!.schema !== version) fail('unsupported implementation schema');
  if (!Array.isArray(m!.nodes) || m!.nodes.length > MAX_NODES || !Array.isArray(m!.blocks) || !Array.isArray(m!.anchors) ||
      !Array.isArray(m!.configs) || m!.configs.length !== 2 || !m!.configs.every(legacy ? legacyConfigValid : configValid)) fail('invalid manifest');
  if (legacy) m!.configs = m!.configs.map(config => ({ ...config, sound: false }));
  const chunks: Blob[] = [], buffers = new Map<number, ArrayBuffer>();
  let uncompressed = 0;
  let offset = HEADER + length;
  for (const b of m!.blocks) {
    if (!b || !integer(b.size) || !integer(b.storedSize) || (b.encoding !== 'raw' && b.encoding !== 'gzip') ||
        (b.encoding === 'raw' && b.size !== b.storedSize) || typeof b.hash !== 'string' || !/^[a-f0-9]{64}$/.test(b.hash) ||
        offset + b.storedSize > blob.size) fail('invalid binary block');
    uncompressed += b.size;
    if (uncompressed > 16 * 1024 ** 3 || (b.encoding === 'gzip' && b.size > 1024 ** 3)) fail('binary blocks exceed supported size');
    let chunk = blob.slice(offset, offset + b.storedSize);
    if (await hash(await chunk.arrayBuffer()) !== b.hash) fail('binary integrity mismatch');
    if (b.encoding === 'gzip') {
      if (typeof DecompressionStream === 'undefined') fail('gzip decompression is unavailable');
      const reader = chunk.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > b.size) { await reader.cancel(); fail('decompressed block exceeds declared size'); }
          parts.push(part.value);
        }
      } catch { fail('invalid compressed block'); }
      if (size !== b.size) fail('decompressed block size mismatch');
      chunk = new Blob(parts);
    }
    chunks.push(chunk); offset += b.storedSize;
  }
  if (offset !== blob.size) fail('unexpected trailing data');
  const dual = new DualMachine('loopback-rts', [new Machine(m!.configs[0]), new Machine(m!.configs[1])]);
  const reg = registry(dual), objects: unknown[] = new Array(m!.nodes.length), anchored = new Set<number>(), anchorNames = new Set<string>();
  for (const a of m!.anchors) {
    if (!Array.isArray(a) || a.length !== 3 || !integer(a[0], objects.length - 1) || anchored.has(a[0])) fail('invalid runtime anchor');
    const [id, who, path] = a;
    const name = `${who}:${path}`;
    if (anchorNames.has(name)) fail('duplicate runtime anchor');
    anchorNames.add(name);
    let obj: unknown;
    if (who === -1 && path === 'dual') obj = dual;
    else if (who === -1 && path === 'link') obj = dual.link;
    else if ((who === 0 || who === 1) && (path === '' || anchorPaths.includes(path))) obj = path ? at(dual.m[who], path) : dual.m[who];
    else fail('invalid runtime anchor path');
    if (!obj || m!.nodes[id]?.t !== className(obj as object)) fail('runtime anchor type mismatch');
    objects[id] = obj; anchored.add(id);
  }
  const validValue = (v: unknown): v is Value => {
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (!v || typeof v !== 'object' || Object.keys(v).length !== 1) return false;
    const x = v as Record<string, unknown>;
    return 'r' in x ? integer(x.r, objects.length - 1) : 'n' in x ? ['NaN', 'Infinity', '-Infinity'].includes(x.n as string) :
      'b' in x ? typeof x.b === 'string' && /^-?\d{1,100}$/.test(x.b) : x.u === true;
  };
  for (let i = 0; i < m!.nodes.length; i++) {
    const n = m!.nodes[i];
    if (!n || typeof n.t !== 'string') fail('invalid node');
    const allowed = reg.has(n.t) || n.t === 'Object' ? ['t', 'p'] :
      n.t === 'Blob' ? ['t', 'parts', 'mime'] : n.t === 'ArrayBuffer' ? ['t', 'block'] :
      n.t === 'NumberArray' ? ['t', 'block', 'length'] : n.t === 'Map' ? ['t', 'e'] :
      Object.hasOwn(views, n.t) ? ['t', 'v', 'offset', 'length'] : ['t', 'v'];
    if (Object.keys(n).some(k => !allowed.includes(k))) fail('unexpected node properties');
    if (reg.has(n.t) || n.t === 'Object') {
      if (!Array.isArray(n.p) || n.p.some(p => !Array.isArray(p) || p.length !== 2 || typeof p[0] !== 'string' || !safeKey(p[0]) || !validValue(p[1]))) fail('invalid properties');
      const keys = n.p!.map(p => p[0]);
      if (new Set(keys).size !== keys.length) fail('duplicate property');
      const entry = reg.get(n.t);
      const expected = legacy && n.t === 'Machine' ? entry?.fields.filter(k => k !== 'sound') : entry?.fields;
      if (entry && JSON.stringify(keys.slice().sort()) !== JSON.stringify(expected)) fail(`invalid ${n.t} schema`);
      if (entry && !anchored.has(i) && !specialFields[n.t]) fail('missing runtime anchor');
      if (!objects[i]) objects[i] = entry ? Object.create(entry.prototype) : {};
    } else if (n.t === 'Blob' || n.t === 'ArrayBuffer' || n.t === 'NumberArray') {
      if (n.t === 'Blob') {
        if (typeof n.mime !== 'string' || !Array.isArray(n.parts) || !n.parts.every(p => integer(p, chunks.length - 1))) fail('invalid Blob');
        objects[i] = new Blob(n.parts!.map(p => chunks[p]), { type: n.mime });
      } else {
        if (!integer(n.block, chunks.length - 1)) fail('invalid block reference');
        let buffer = buffers.get(n.block!);
        if (!buffer) { buffer = await chunks[n.block!].arrayBuffer(); buffers.set(n.block!, buffer); }
        if (n.t === 'NumberArray') {
          if (!integer(n.length) || n.length! * 8 !== buffer.byteLength) fail('invalid numeric array');
          objects[i] = Array.from(new Float64Array(buffer));
        } else objects[i] = buffer;
      }
    } else if (n.t === 'Map') {
      if (!Array.isArray(n.e) || n.e.some(e => !Array.isArray(e) || e.length !== 2 || !e.every(validValue))) fail('invalid map');
      objects[i] = new Map();
    } else if (['Array', 'Set', 'Date'].includes(n.t) || Object.hasOwn(views, n.t)) {
      if (!Array.isArray(n.v) || !n.v.every(validValue)) fail('invalid values');
      objects[i] = n.t === 'Array' ? [] : n.t === 'Set' ? new Set() : n.t === 'Date' ? new Date(0) : undefined;
    } else fail('unknown object type');
  }
  const decode = (v: Value): unknown => {
    if (!validValue(v)) fail('invalid value');
    if (v === null || typeof v !== 'object') return v;
    if ('r' in v) return objects[v.r];
    if ('b' in v) return BigInt(v.b);
    if ('n' in v) return Number(v.n);
    return undefined;
  };
  for (let i = 0; i < m!.nodes.length; i++) {
    const n = m!.nodes[i];
    if (!Object.hasOwn(views, n.t)) continue;
    const buffer = n.v?.length === 1 ? decode(n.v[0]) : null;
    if (!(buffer instanceof ArrayBuffer) || !integer(n.offset) || !integer(n.length) || n.offset + n.length > buffer.byteLength) fail('invalid binary view');
    const ctor = views[n.t as keyof typeof views];
    const size = 'BYTES_PER_ELEMENT' in ctor ? ctor.BYTES_PER_ELEMENT : 1;
    if (n.offset! % size || n.length! % size) fail('unaligned binary view');
    const make = ctor as unknown as new (buffer: ArrayBuffer, offset: number, length: number) => ArrayBufferView;
    objects[i] = new make(buffer as ArrayBuffer, n.offset!, n.t === 'DataView' ? n.length! : n.length! / size);
  }
  for (let i = 0; i < m!.nodes.length; i++) {
    const n = m!.nodes[i], obj = objects[i];
    if (n.p) for (const [key, value] of n.p) {
      const v = decode(value), seed = reg.get(n.t)?.seed as AnyObject | undefined;
      if (seed && typeof seed[key] !== 'object' && seed[key] !== undefined && typeof v !== typeof seed[key]) fail(`invalid ${n.t}.${key}`);
      if (seed && seed[key] !== null && typeof seed[key] === 'object') {
        const expected = seed[key] as object;
        if (ArrayBuffer.isView(expected)) {
          if (!ArrayBuffer.isView(v) || Object.getPrototypeOf(v) !== Object.getPrototypeOf(expected)) fail(`invalid ${n.t}.${key} binary type`);
          if (['CPU', 'History', 'X87', 'DMA', 'Planar', 'Mouse', 'Video', 'Machine'].includes(n.t) && (v as ArrayBufferView).byteLength !== expected.byteLength) fail(`invalid ${n.t}.${key} binary length`);
        } else if (Array.isArray(expected) && !Array.isArray(v)) fail(`invalid ${n.t}.${key} array`);
        else if (expected instanceof Map && !(v instanceof Map)) fail(`invalid ${n.t}.${key} map`);
        else if (expected instanceof Set && !(v instanceof Set)) fail(`invalid ${n.t}.${key} set`);
        else if (className(expected) && !['UART.peer', 'CPU.fpu', 'PIC.slave'].includes(`${n.t}.${key}`) &&
          (!(v instanceof Object) || className(v) !== className(expected))) fail(`invalid ${n.t}.${key} reference`);
      }
      Object.defineProperty(obj, key, { value: v, writable: true, configurable: true, enumerable: true });
    }
    else if (n.t === 'Array') for (const v of n.v!) (obj as unknown[]).push(decode(v));
    else if (n.t === 'Set') for (const v of n.v!) (obj as Set<unknown>).add(decode(v));
    else if (n.t === 'Map') for (const [k, v] of n.e!) (obj as Map<unknown, unknown>).set(decode(k), decode(v));
    else if (n.t === 'Date') {
      const time = n.v!.length === 1 ? decode(n.v![0]) : undefined;
      if (typeof time !== 'number' || !Number.isFinite(time)) fail('invalid date');
      (obj as Date).setTime(time as number);
    }
    for (let i = 0; i < m!.nodes.length; i++) {
      if (m!.nodes[i].t === 'BlobSource') Object.defineProperty(objects[i], 'pending', { value: new Map(), writable: true });
    }
  }
  const root = decode(m!.root) as LoadedSnapshot & { font: Uint8Array | null };
  if (!root || root.dual !== dual || !modeValid(root.mode) || !workspaceValid(root.workspace) || !(root.font === null || root.font instanceof Uint8Array) ||
      !Array.isArray(dual.m) || dual.m.length !== 2 || dual.m.some(v => !(v instanceof Machine)) || !(dual.link instanceof NullModem)) fail('invalid snapshot root');
  const required = new Set(m!.anchors.map(a => `${a[1]}:${a[2]}`));
  if (!required.has('-1:dual') || !required.has('-1:link')) fail('missing dual anchors');
  for (let i = 0; i < 2; i++) {
    const machine = dual.m[i];
    if (legacy) Object.defineProperty(machine.config, 'sound', { value: false, writable: true, configurable: true, enumerable: true });
    const anchorMachine = m!.anchors.find(a => a[1] === i && a[2] === '');
    if (!anchorMachine || machine !== objects[anchorMachine[0]]) fail('machine anchor mismatch');
    if (!required.has(`${i}:`) || !configValid(machine.config) || Object.keys(DEFAULT_CONFIG).some(k => machine.config[k as keyof MachineConfig] !== m!.configs[i][k as keyof MachineConfig])) fail('invalid machine configuration');
    for (const path of anchorPaths) {
      if (legacy && path === 'sound') continue;
      if (path === 'cpu.fpu' && !machine.config.fpu) continue;
      const anchor = m!.anchors.find(a => a[1] === i && a[2] === path);
      if (!anchor || at(machine, path) !== objects[anchor[0]]) fail('invalid machine runtime graph');
    }
    if (machine.mem !== machine.cpu.mem || !(machine.mem instanceof Uint8Array) || machine.mem.length !== 0x1000000 ||
        !(machine.cpu.r instanceof Uint16Array) || machine.cpu.r.length !== 8 || !(machine.cpu.s instanceof Uint16Array) || machine.cpu.s.length !== 6) fail('invalid CPU memory/registers');
    Object.freeze(machine.config);
    validatePersistentState(machine);
    // Do not call pause(): it clears waiting and debugger continuation state.
    if (['running', 'ready', 'waiting', 'paused'].includes(machine.status)) machine.status = 'paused';
    const hle = machine.hle as unknown as { m: Machine; cpu: CPU };
    if (hle.m !== machine || hle.cpu !== machine.cpu ||
        (machine.dosmem as unknown as { cpu: CPU }).cpu !== machine.cpu ||
        (machine.kbd as unknown as { pic: PIC }).pic !== machine.pic ||
        (machine.serialMouse as unknown as { mouse: Mouse }).mouse !== machine.mouse ||
        machine.link !== dual.link || machine.pic.slave !== (machine.config.slavePic ? machine.pic2 : null) ||
        machine.com2.peer !== (machine.config.com2 && machine.config.serialMouse ? machine.serialMouse : null)) fail('invalid callback dependency graph');
  }
  if (dual.link.a !== dual.m[0].com1 || dual.link.b !== dual.m[1].com1 ||
      !['full', 'loopback-rts', 'three-wire'].includes(dual.link.wiring) ||
      (dual.m[0].com1.peer !== null && dual.m[0].com1.peer !== dual.link) ||
      (dual.m[1].com1.peer !== null && dual.m[1].com1.peer !== dual.link) ||
      (dual.m[0].com1.peer === null) !== (dual.m[1].com1.peer === null)) fail('invalid null modem graph');
  const inflight = (dual.link as unknown as { inflight: AnyObject[] }).inflight;
  if (!Array.isArray(inflight) || inflight.some(v => !v || (v.to !== dual.link.a && v.to !== dual.link.b) ||
      !integer(v.byte, 255) || typeof v.time !== 'number' || !Number.isFinite(v.time) || v.time < 0 || typeof v.frameOk !== 'boolean')) fail('invalid serial inflight state');
  Machine.font = root.font;
  for (const machine of dual.m) machine.cdrom.restoreMediaRead();
  return { dual, mode: root.mode, workspace: root.workspace };
}
