#pragma once
#include "pc.h"

namespace asm86 {
class SnapshotArchive;
// Must be called on the VM thread between instructions. Loading constructs a new Pc.
class Snapshot {
public:
    static void save(Pc& pc, const std::filesystem::path& path);
    static std::unique_ptr<Pc> load(const std::filesystem::path& path);
private:
    static void state(SnapshotArchive& archive, Pc& pc);
    static void disk(SnapshotArchive& archive, std::unique_ptr<Disk>& disk, bool floppy);
    static void optical(SnapshotArchive& archive, AtapiCdrom& cdrom);
    static void validate(const Pc& pc);
};
}
