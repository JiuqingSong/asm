// Windows 2000 (NT 5.0 build 2195, x86 non-PAE) RAM-dump walker for the native VM's `dump` output.
// Lists processes, then each thread's state, wait objects and a heuristic user-mode stack
// (return addresses into loaded modules, symbolized by nearest export).
// Usage: node tools/nt-walk.mjs ram.bin [process.exe ...]
// Structure offsets are NT 5.0-specific (EPROCESS ImageFileName 0x1fc, KTHREAD State 0x2d, ...).
import fs from 'fs';
const [, , dumpPath, ...flags] = process.argv;
const mem = fs.readFileSync(dumpPath);
const u8 = (p) => mem[p], u16 = (p) => mem.readUInt16LE(p), u32 = (p) => mem.readUInt32LE(p);
const hex = (v) => (v >>> 0).toString(16);

function v2p(cr3, va) {
  va >>>= 0;
  const pde = u32((cr3 & ~0xfff) + ((va >>> 22) << 2));
  if (!(pde & 1)) return -1;
  if (pde & 0x80) return (pde & 0xffc00000) + (va & 0x3fffff);
  const ptAddr = (pde & ~0xfff) + (((va >>> 12) & 0x3ff) << 2);
  if (ptAddr >= mem.length) return -1;
  const pte = u32(ptAddr);
  if (!(pte & 1)) return -1;
  const p = (pte & ~0xfff) + (va & 0xfff);
  return p < mem.length ? p : -1;
}
const r32 = (cr3, va) => { const p = v2p(cr3, va); return p < 0 || p + 4 > mem.length ? null : (((va & 0xfff) > 0xffc) ? null : u32(p)); };
const r16 = (cr3, va) => { const p = v2p(cr3, va); return p < 0 ? null : u16(p); };
const r8 = (cr3, va) => { const p = v2p(cr3, va); return p < 0 ? null : u8(p); };
function rbytes(cr3, va, n) { const out = []; for (let i = 0; i < n; i++) { const b = r8(cr3, va + i); if (b === null) return null; out.push(b); } return Buffer.from(out); }
function rustr(cr3, va) { // UNICODE_STRING
  const len = r16(cr3, va), buf = r32(cr3, va + 4); if (!len || buf === null) return '';
  const b = rbytes(cr3, buf, len); return b ? b.toString('utf16le') : '?';
}

// Find EPROCESS candidates: Header.Type=3, Size=0x1b; ImageFileName at 0x1fc.
const procs = [];
for (let p = 0; p + 0x290 < mem.length; p += 8) {
  if (mem[p] !== 3 || mem[p + 2] !== 0x1b) continue;
  const dtb = u32(p + 0x18);
  if (dtb & 0xfff || dtb === 0 || dtb >= mem.length) continue;
  const name = mem.subarray(p + 0x1fc, p + 0x1fc + 16);
  const z = name.indexOf(0); const s = name.subarray(0, z < 0 ? 16 : z).toString('latin1');
  if (!/^[\x20-\x7e]{2,16}$/.test(s)) continue;
  procs.push({ phys: p, dtb, name: s, pid: u32(p + 0x9c), peb: u32(p + 0x1b0) });
}
const sysDtb = (procs.find((x) => x.name === 'System') || procs[0]).dtb;
// Each EPROCESS's own virtual address: ActiveProcessLinks.Blink->Flink points back at it.
for (const pr of procs) {
  pr.va = null;
  const bp = v2p(sysDtb, u32(pr.phys + 0xa4)); if (bp >= 0) pr.va = u32(bp) - 0xa0;
}
console.log('processes:');
for (const pr of procs) console.log(`  ${pr.name.padEnd(16)} pid=${hex(pr.pid)} eproc=${pr.va !== null ? hex(pr.va) : '?'} phys=${hex(pr.phys)} cr3=${hex(pr.dtb)}`);

// Threads: Header.Type=6, Size=0x6c; ApcState.Process at 0x44.
const byVa = new Map(procs.filter((p) => p.va).map((p) => [p.va >>> 0, p]));
const threads = [];
for (let p = 0; p + 0x250 < mem.length; p += 8) {
  if (mem[p] !== 6 || mem[p + 2] !== 0x6c) continue;
  const proc = byVa.get(u32(p + 0x44) >>> 0);
  if (!proc) continue;
  threads.push({ phys: p, proc });
}
const STATES = ['Init', 'Ready', 'Running', 'Standby', 'Term', 'Wait', 'Trans'];
const objType = (cr3, va) => { const t = r8(cr3, va); return t === null ? '?' : (['NotifEvent', 'SyncEvent', 'Mutant', 'Process', 'Queue', 'Semaphore', 'Thread', '?', 'NotifTimer', 'SyncTimer'][t] || `type${t}`); };

// Module lists per process (user mode)
function modules(proc) {
  const cr3 = proc.dtb, mods = [];
  if (!proc.peb) return mods;
  const ldr = r32(cr3, proc.peb + 0xc); if (!ldr) return mods;
  let e = r32(cr3, ldr + 0xc), n = 0;
  while (e && e !== ldr + 0xc && n++ < 200) {
    mods.push({ base: r32(cr3, e + 0x18), size: r32(cr3, e + 0x20), name: rustr(cr3, e + 0x2c) });
    e = r32(cr3, e);
  }
  return mods;
}
const expCache = new Map();
function exportsOf(cr3, base) {
  const key = cr3 + ':' + base; if (expCache.has(key)) return expCache.get(key);
  const out = [];
  try {
    const pe = base + r32(cr3, base + 0x3c);
    const dirRva = r32(cr3, pe + 0x78);
    if (dirRva) {
      const d = base + dirRva, nNames = r32(cr3, d + 0x18), funcs = base + r32(cr3, d + 0x1c), names = base + r32(cr3, d + 0x20), ords = base + r32(cr3, d + 0x24);
      for (let i = 0; i < nNames && i < 5000; i++) {
        const nameVa = base + r32(cr3, names + i * 4); const ord = r16(cr3, ords + i * 2);
        const rva = r32(cr3, funcs + ord * 4); const nb = rbytes(cr3, nameVa, 48);
        if (!nb || rva === null) continue; const z = nb.indexOf(0);
        out.push({ rva, name: nb.subarray(0, z < 0 ? 48 : z).toString('latin1') });
      }
    }
  } catch { }
  out.sort((a, b) => a.rva - b.rva); expCache.set(key, out); return out;
}
function sym(cr3, mods, va) {
  for (const m of mods) if (m.base && va >= m.base && va < m.base + m.size) {
    const ex = exportsOf(cr3, m.base); let best = null;
    for (const e of ex) if (e.rva <= va - m.base) best = e; else break;
    return `${m.name}!${best ? best.name + '+' + hex(va - m.base - best.rva) : hex(va - m.base)}`;
  }
  return hex(va);
}

const want = flags.length ? flags : null;
for (const t of threads) {
  const p = t.phys, proc = t.proc;
  if (want && !want.includes(proc.name)) continue;
  const cr3 = proc.dtb;
  const state = mem[p + 0x2d], waitReason = mem[p + 0x57], waitMode = mem[p + 0x55];
  const cid = u32(p + 0x1e4), start = u32(p + 0x218), w32start = u32(p + 0x224);
  const teb = u32(p + 0x20);
  const line = `thread phys=${hex(p)} ${proc.name} tid=${hex(cid)} state=${STATES[state] || state} wr=${waitReason} mode=${waitMode} teb=${hex(teb)} start=${hex(start)} w32=${hex(w32start)}`;
  console.log(line);
  if (state === 5) {
    let wb = u32(p + 0x58), n = 0; const first = wb;
    do {
      const obj = r32(cr3, wb + 0xc), wtype = r16(cr3, wb + 0x16);
      if (obj === null) break;
      const sig = r32(cr3, obj + 4);
      console.log(`   wait obj=${hex(obj)} ${objType(cr3, obj)} signal=${sig} waitType=${wtype}`);
      wb = r32(cr3, wb + 0x10);
    } while (wb && wb !== first && ++n < 64);
  }
  // user stack via trap frame
  const initialStack = u32(p + 0x18);
  const tf = initialStack - 0x210 - 0x8c;
  const ueip = r32(cr3, tf + 0x68), uesp = r32(cr3, tf + 0x74), uebp = r32(cr3, tf + 0x60), ucs = r32(cr3, tf + 0x6c);
  if (teb && ueip !== null && (ucs & 3) === 3) {
    const mods = modules(proc);
    const frames = [sym(cr3, mods, ueip)];
    // scan stack for return addresses into modules
    for (let i = 0; i < 400 && frames.length < 30; i++) {
      const v = r32(cr3, uesp + i * 4); if (v === null) break;
      for (const m of mods) if (m.base && v > m.base + 0x1000 && v < m.base + m.size) { frames.push(`[esp+${hex(i * 4)}] ` + sym(cr3, mods, v)); break; }
    }
    console.log('   user: ' + frames.join('\n         '));
  }
}
