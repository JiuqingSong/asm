export class Memory {
  readonly size = 0x10000;
  private bytes = new Uint8Array(this.size);

  reset(): void { this.bytes.fill(0); }

  private checkAddress(address: number): void {
    if (!Number.isInteger(address) || address < 0 || address >= this.size) {
      throw new Error('地址必须位于 0～65535');
    }
  }

  read8(address: number): number {
    this.checkAddress(address);
    return this.bytes[address];
  }

  write8(address: number, value: number): void {
    this.checkAddress(address);
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new Error('字节必须位于 0～255');
    this.bytes[address] = value;
  }

  peek(address: number, length: number): Uint8Array {
    if (!Number.isInteger(address) || !Number.isInteger(length) || address < 0 || length < 0 || address + length > this.size) {
      throw new Error('查看范围必须位于 64KB 内存中');
    }
    return this.bytes.slice(address, address + length);
  }
}
