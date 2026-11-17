// "从磁盘启动"用的程序描述：没有程序映像，装载时由 Machine 读引导扇区
import type { Program } from '../asm/types.ts';
import { driveName } from './machine.ts';

export function bootProgram(drive: number): Program {
  return {
    ok: true, diagnostics: [], format: 'boot', bootDrive: drive,
    loadSeg: 0, pspSeg: 0, chunks: [], entry: { cs: 0, ip: 0x7c00 }, stack: { ss: 0, sp: 0x7c00 },
    lineToAddrs: new Map(), addrToLine: new Map(), symbols: [], listing: [], segments: [],
    imageStart: 0x7c00, imageEnd: 0x7e00, dataSeg: 0,
  };
}

export { driveName };
