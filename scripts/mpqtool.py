#!/usr/bin/env python3
"""MPQ tool for StarCraft II maps/mods (read + write).

Self-contained reader and writer. Every compression type SC2 uses is decoded
(zlib / bzip2 / LZMA / PKWare implode). Blocks that cannot be decoded are
copied through byte-for-byte with their original flags, so a repack never
loses data it does not understand.

Commands
    list   <archive>
    read   <archive> <name> [--out FILE]
    info   <archive>
    repack <src> <dst> [--replace NAME=FILE]... [--add NAME=FILE]... [--delete NAME]...
    pack   <dir> <dst>
    unpack <archive> <dir> [--filter SUBSTR]

Every command prints one JSON object on stdout.
"""

import bz2
import json
import lzma
import os
import struct
import sys
import zlib

MPQ_MAGIC = b"MPQ\x1a"
HASH_TABLE_OFFSET = 0
HASH_NAME_A = 1
HASH_NAME_B = 2
HASH_FILE_KEY = 3

FLAG_IMPLODE = 0x00000100
FLAG_COMPRESS = 0x00000200
FLAG_ENCRYPTED = 0x00010000
FLAG_SINGLE_UNIT = 0x01000000
FLAG_EXISTS = 0x80000000


# --------------------------------------------------------------- hashing


def _build_crypt_table():
    table = [0] * 0x500
    seed = 0x00100001
    for index1 in range(0x100):
        index2 = index1
        for _ in range(5):
            seed = (seed * 125 + 3) % 0x2AAAAB
            temp1 = (seed & 0xFFFF) << 0x10
            seed = (seed * 125 + 3) % 0x2AAAAB
            temp2 = seed & 0xFFFF
            table[index2] = (temp1 | temp2) & 0xFFFFFFFF
            index2 += 0x100
    return table


CRYPT = _build_crypt_table()


def hash_string(name, hash_type):
    if isinstance(name, bytes):
        name = name.decode("utf-8", "replace")
    name = name.replace("/", "\\").upper()
    seed1 = 0x7FED7FED
    seed2 = 0xEEEEEEEE
    for ch in name:
        code = ord(ch)
        if code > 0xFF:
            # Non-ASCII names never round-trip through Storm's byte hash; fall
            # back to the UTF-8 byte sequence so distinct names stay distinct.
            for byte in ch.encode("utf-8"):
                seed1 = (CRYPT[(hash_type << 8) + byte] ^ (seed1 + seed2)) & 0xFFFFFFFF
                seed2 = (byte + seed1 + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
            continue
        seed1 = (CRYPT[(hash_type << 8) + code] ^ (seed1 + seed2)) & 0xFFFFFFFF
        seed2 = (code + seed1 + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return seed1 & 0xFFFFFFFF


def _next_pow2(n):
    p = 1
    while p < n:
        p <<= 1
    return p


def encrypt_block(data, key):
    """Blizzard's table encryption: the exact inverse of decrypt_block."""
    count = len(data) // 4
    words = list(struct.unpack("<%dI" % count, data[: count * 4]))
    seed1 = key & 0xFFFFFFFF
    seed2 = 0xEEEEEEEE
    for i in range(count):
        seed2 = (seed2 + CRYPT[0x400 + (seed1 & 0xFF)]) & 0xFFFFFFFF
        ch = words[i]
        words[i] = (ch ^ ((seed1 + seed2) & 0xFFFFFFFF)) & 0xFFFFFFFF
        seed1 = (((((0xFFFFFFFF ^ seed1) << 0x15) & 0xFFFFFFFF) + 0x11111111) & 0xFFFFFFFF) | (seed1 >> 0x0B)
        seed1 &= 0xFFFFFFFF
        seed2 = (ch + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return struct.pack("<%dI" % count, *words)


def decrypt_block(data, key):
    """Blizzard's table decryption (hash/block tables in v1+ archives)."""
    count = len(data) // 4
    words = list(struct.unpack("<%dI" % count, data[: count * 4]))
    seed1 = key & 0xFFFFFFFF
    seed2 = 0xEEEEEEEE
    for i in range(count):
        seed2 = (seed2 + CRYPT[0x400 + (seed1 & 0xFF)]) & 0xFFFFFFFF
        ch = (words[i] ^ ((seed1 + seed2) & 0xFFFFFFFF)) & 0xFFFFFFFF
        seed1 = (((((0xFFFFFFFF ^ seed1) << 0x15) & 0xFFFFFFFF) + 0x11111111) & 0xFFFFFFFF) | (seed1 >> 0x0B)
        seed1 &= 0xFFFFFFFF
        seed2 = (ch + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
        words[i] = ch
    return struct.pack("<%dI" % count, *words)


# --------------------------------------------------------------- decoding


class UnsupportedCompression(Exception):
    pass


def _decompress_type(raw, ctype):
    """Decompress one payload by an explicit StormLib compression type."""
    if ctype == 0:
        return raw
    if ctype == 0x02:
        return zlib.decompress(raw)
    if ctype == 0x10:
        return bz2.decompress(raw)
    if ctype == 0x12:
        return _lzma_decompress(raw)
    raise UnsupportedCompression("type 0x%02x" % ctype)


def _decompress(raw, mask):
    out = raw
    for bit in (0x01, 0x02, 0x04, 0x08, 0x10, 0x12, 0x20, 0x40, 0x80):
        if not mask & bit:
            continue
        if bit == 0x01:
            raise UnsupportedCompression("huffman")
        if bit == 0x02:
            out = zlib.decompress(out)
        elif bit == 0x08:
            raise UnsupportedCompression("pkware implode")
        elif bit == 0x10:
            out = bz2.decompress(out)
        elif bit == 0x12:
            out = _lzma_decompress(out)
        elif bit == 0x04:
            out = zlib.decompress(out)
        else:
            raise UnsupportedCompression("bit 0x%02x" % bit)
    return out


def _lzma_decompress(raw):
    props = raw[:5]
    size = struct.unpack("<Q", raw[5:13])[0]
    header = props[0]
    lc = header % 9
    rest = header // 9
    lp = rest % 5
    pb = rest // 5
    dict_size = struct.unpack("<I", props[1:5])[0]
    dec = lzma.LZMADecompressor(
        format=lzma.FORMAT_RAW,
        filters=[{
            "id": lzma.FILTER_LZMA1,
            "dict_size": max(dict_size, 4096),
            "lc": lc,
            "lp": lp,
            "pb": pb,
        }],
    )
    data = dec.decompress(raw[13:], max_length=size)
    return data


# --------------------------------------------------------------- archive


class MPQ:
    def __init__(self, path):
        self.path = path
        self.fh = open(path, "rb")
        head = self.fh.read(32)
        magic, header_size, archive_size, version, shift, hash_pos, block_pos, hash_size, block_count = (
            struct.unpack("<4sIIHHIIII", head)
        )
        if magic != MPQ_MAGIC:
            raise ValueError("not an MPQ archive: %s" % path)
        # v1+ archives carry an extended header (hi-block table). SC2 archives
        # never exceed 65535 blocks, so the base block count is authoritative.

        self.version = version
        self.sector_shift = shift
        self.sector_size = 512 << shift
        self.archive_size = archive_size
        self.hash_pos = hash_pos
        self.block_pos = block_pos
        self.hash_size = hash_size
        self.block_count = block_count
        self.blocks = self._read_block_table()
        self.names, self.hash_map = self._read_hash_table()

    def _read_block_table(self):
        self.fh.seek(self.block_pos)
        raw = self.fh.read(16 * self.block_count)
        if raw:
            raw = decrypt_block(raw, hash_string("(block table)", HASH_FILE_KEY))
        self.raw_block_table = raw
        blocks = []
        for i in range(self.block_count):
            file_pos, csize, fsize, flags = struct.unpack("<IIII", raw[i * 16:(i + 1) * 16])
            blocks.append({"pos": file_pos, "csize": csize, "fsize": fsize, "flags": flags})
        return blocks

    def _read_hash_table(self):
        self.fh.seek(self.hash_pos)
        raw = self.fh.read(16 * self.hash_size)
        if raw:
            raw = decrypt_block(raw, hash_string("(hash table)", HASH_FILE_KEY))
        self.raw_hash_table = raw
        hash_map = {}
        for i in range(self.hash_size):
            h1, h2, locale, platform, block = struct.unpack("<IIHHI", raw[i * 16:(i + 1) * 16])
            if block != 0xFFFFFFFF and block < len(self.blocks):
                hash_map[(h1, h2)] = block
        names = []
        self.hash_map = hash_map
        try:
            listing = self.read_file("(listfile)")
            names = [n for n in listing.decode("utf-8", "replace").splitlines() if n.strip()]
        except Exception:
            names = []
        return names, hash_map

    def close(self):
        try:
            self.fh.close()
        except Exception:
            pass

    def _block_for(self, name):
        key = (hash_string(name, HASH_NAME_A), hash_string(name, HASH_NAME_B))
        return self.hash_map.get(key)

    def read_raw(self, name):
        index = self._block_for(name)
        if index is None:
            raise KeyError("file not found: %s" % name)
        block = self.blocks[index]
        self.fh.seek(block["pos"])
        return self.fh.read(block["csize"]), block

    def read_file(self, name):
        index = self._block_for(name)
        if index is None:
            raise KeyError("file not found: %s" % name)
        return self.read_block(index)

    def read_block(self, index):
        block = self.blocks[index]
        self.fh.seek(block["pos"])
        raw = self.fh.read(block["csize"])
        flags = block["flags"]
        mask = (flags >> 8) & 0xFF
        if block["csize"] == 0:
            return b""
        if flags & FLAG_ENCRYPTED:
            raise UnsupportedCompression("encrypted block")
        if flags & FLAG_SINGLE_UNIT:
            # StormLib: a compressed single-unit block starts with its type byte.
            if mask:
                if not raw:
                    return b""
                return _decompress_type(raw[1:], raw[0])
            return raw
        # Sector table: the first entry is the table's own size, which keeps
        # this correct for archives with (sector CRC) tables appended.
        first = struct.unpack("<I", raw[:4])[0]
        if first == 0 or first % 4 or first > len(raw):
            raise UnsupportedCompression("bad sector table")
        table_entries = first // 4
        offsets = struct.unpack("<%dI" % table_entries, raw[:first])
        out = bytearray()
        produced = 0
        for i in range(table_entries - 1):
            if produced >= block["fsize"]:
                break
            chunk = raw[offsets[i]: offsets[i + 1]]
            if not chunk:
                continue
            if mask and len(chunk) < self.sector_size and chunk[0] in (0x02, 0x10, 0x12):
                try:
                    data = _decompress_type(chunk[1:], chunk[0])
                except UnsupportedCompression:
                    raise
                except Exception:
                    # Trailing sector-CRC block: not file content.
                    break
            else:
                data = chunk
            out.extend(data)
            produced += len(data)
        if len(out) < block["fsize"]:
            raise UnsupportedCompression("short read %d/%d" % (len(out), block["fsize"]))
        return bytes(out[: block["fsize"]])
        return bytes(out)


# --------------------------------------------------------------- writer


def _encode(data, sector_size=16384):
    """Return (payload, flags, csize, fsize) for a newly written file.

    Files are stored sector-based with per-sector zlib, which is exactly how
    the SC2 editor itself writes them. Compressed single-unit blocks are valid
    MPQ, but the editor's reader is stricter than StormLib about them.
    """
    if not data:
        return b"", FLAG_EXISTS | FLAG_SINGLE_UNIT, 0, 0
    if len(data) <= sector_size:
        packed = b"\x02" + zlib.compress(data, 9)
        if len(packed) < len(data):
            return packed, FLAG_EXISTS | FLAG_SINGLE_UNIT | FLAG_COMPRESS, len(packed), len(data)
        return data, FLAG_EXISTS | FLAG_SINGLE_UNIT, len(data), len(data)

    chunks = []
    for start in range(0, len(data), sector_size):
        sector = data[start:start + sector_size]
        packed = b"\x02" + zlib.compress(sector, 9)
        chunks.append(packed if len(packed) < len(sector) else sector)
    table_size = (len(chunks) + 1) * 4
    offsets = []
    cursor = table_size
    for chunk in chunks:
        offsets.append(cursor)
        cursor += len(chunk)
    offsets.append(cursor)
    table = struct.pack("<%dI" % len(offsets), *offsets)
    payload = table + b"".join(chunks)
    return payload, FLAG_EXISTS | FLAG_COMPRESS, len(payload), len(data)


def write_archive(path, entries, sector_size=16384):
    """entries: list of dicts {name, data?} or {name, raw, flags, csize, fsize}.

    Layout matches StormLib and the SC2 editor: header, file data, hash table,
    block table - both tables encrypted with their Storm keys.
    """
    prepared = []
    for entry in entries:
        if "raw" in entry:
            prepared.append({
                "name": entry["name"],
                "payload": entry["raw"],
                "flags": entry["flags"],
                "csize": entry["csize"],
                "fsize": entry["fsize"],
            })
        else:
            payload, flags, csize, fsize = _encode(entry["data"], sector_size)
            prepared.append({
                "name": entry["name"],
                "payload": payload,
                "flags": flags,
                "csize": csize,
                "fsize": fsize,
            })

    header_size = 32
    body = bytearray()
    offset = header_size
    placed = []
    for item in prepared:
        body.extend(item["payload"])
        placed.append((item, offset))
        offset += len(item["payload"])

    hash_size = _next_pow2(max(4, len(placed) * 2))
    slots = [None] * hash_size
    for index, (item, _pos) in enumerate(placed):
        start = hash_string(item["name"], HASH_TABLE_OFFSET) & (hash_size - 1)
        probe = 0
        while slots[(start + probe) & (hash_size - 1)] is not None:
            probe += 1
        slots[(start + probe) & (hash_size - 1)] = (
            hash_string(item["name"], HASH_NAME_A),
            hash_string(item["name"], HASH_NAME_B),
            index,
        )

    hash_bytes = bytearray()
    for slot in slots:
        if slot is None:
            hash_bytes.extend(struct.pack("<IIHHI", 0xFFFFFFFF, 0xFFFFFFFF, 0xFFFF, 0xFFFF, 0xFFFFFFFF))
        else:
            hash_bytes.extend(struct.pack("<IIHHI", slot[0], slot[1], 0, 0, slot[2]))

    block_table = bytearray()
    for item, pos in placed:
        block_table.extend(struct.pack("<IIII", pos, item["csize"], item["fsize"], item["flags"]))

    hash_table_pos = header_size + len(body)
    block_table_pos = hash_table_pos + len(hash_bytes)
    archive_size = block_table_pos + len(block_table)

    header = struct.pack(
        "<4sIIHHIIII",
        MPQ_MAGIC,
        header_size,
        archive_size,
        0,
        5,
        hash_table_pos,
        block_table_pos,
        hash_size,
        len(placed),
    )
    block_table = encrypt_block(bytes(block_table), hash_string("(block table)", HASH_FILE_KEY))
    hash_bytes = encrypt_block(bytes(hash_bytes), hash_string("(hash table)", HASH_FILE_KEY))

    with open(path, "wb") as fh:
        fh.write(header)
        fh.write(body)
        fh.write(het_bytes)
        fh.write(bet_bytes)
        fh.write(hash_bytes)
        fh.write(block_table)

    raw_count = sum(1 for item in prepared if item["flags"] & FLAG_SINGLE_UNIT == 0)
    return {
        "archive": path,
        "bytes": archive_size,
        "files": len(placed),
        "hashTableSize": hash_size,
        "sectorBasedFiles": raw_count,
    }


def _encode_like(data, block):
    """Encode a replacement using the storage style of the block it replaces."""
    if not data:
        return b"", FLAG_EXISTS | FLAG_SINGLE_UNIT, 0, 0
    if block["flags"] & FLAG_SINGLE_UNIT:
        packed = b"\x02" + zlib.compress(data, 9)
        if len(packed) < len(data):
            return packed, FLAG_EXISTS | FLAG_SINGLE_UNIT | FLAG_COMPRESS, len(packed), len(data)
        return data, FLAG_EXISTS | FLAG_SINGLE_UNIT, len(data), len(data)
    sector_size = 512 << 5
    chunks = []
    for start in range(0, len(data), sector_size):
        sector = data[start:start + sector_size]
        packed = b"\x02" + zlib.compress(sector, 9)
        chunks.append(packed if len(packed) < len(sector) else sector)
    table_size = (len(chunks) + 1) * 4
    offsets = []
    cursor = table_size
    for chunk in chunks:
        offsets.append(cursor)
        cursor += len(chunk)
    offsets.append(cursor)
    table = struct.pack("<%dI" % len(offsets), *offsets)
    payload = table + b"".join(chunks)
    return payload, FLAG_EXISTS | FLAG_COMPRESS, len(payload), len(data)


def _rewrite_tables(fh, archive, blocks, header_pos):
    table = bytearray()
    for b in blocks:
        table.extend(struct.pack("<IIII", b["pos"], b["csize"], b["fsize"], b["flags"]))
    table = encrypt_block(bytes(table), hash_string("(block table)", HASH_FILE_KEY))
    fh.seek(archive.block_pos)
    fh.write(table)


def replace_file(path, name, data):
    """Replace one file in place, keeping the archive layout untouched.

    The SC2 editor pins every file's position: its v3 BET/HET tables and its
    own loader reject archives whose blocks have been shifted or whose tables
    moved. Overwriting the existing block and updating that single block-table
    entry is the only rewrite shape verified to load in the editor, so a
    replacement must fit the space its predecessor occupied.
    """
    archive = MPQ(path)
    index = archive._block_for(name)
    if index is None:
        raise KeyError("file not found in archive: %s" % name)
    old = dict(archive.blocks[index])
    payload, flags, csize, fsize = _encode_like(data, old)
    archive.close()

    if csize > old["csize"] or old["csize"] == 0:
        raise ValueError(
            "replacement needs %d compressed bytes but the existing block holds %d; "
            "in-place writing cannot grow a block. Store the map from the editor once "
            "or shrink the change (the editor rewrites the archive and frees space)."
            % (csize, old["csize"])
        )

    blocks = [{"pos": b["pos"], "csize": b["csize"], "fsize": b["fsize"], "flags": b["flags"]}
              for b in archive.blocks]
    blocks[index] = {"pos": old["pos"], "csize": csize, "fsize": fsize, "flags": flags}
    with open(path, "r+b") as fh:
        fh.seek(old["pos"])
        fh.write(payload)
        _rewrite_tables(fh, archive, blocks, 0)
    return {"archive": path, "name": name, "mode": "in-place",
            "csize": csize, "fsize": fsize, "capacity": old["csize"],
            "size": os.path.getsize(path)}


def collect(archive):
    """Read every file, falling back to raw passthrough when undecodable."""
    names = archive.names
    if not names:
        raise ValueError("archive has no (listfile); cannot enumerate reliably")
    entries = []
    failed = []
    listed = set(names)
    # Blocks that exist in the hash table but never appear in (listfile).
    # SC2 stores file attributes there and the editor refuses a map without it.
    for special in ("(attributes)", "(signature)", "(user data)"):
        if special in listed:
            continue
        index = archive._block_for(special)
        if index is None:
            continue
        block = archive.blocks[index]
        raw, block = archive.read_raw(special)
        entries.append({
            "name": special,
            "raw": raw,
            "flags": block["flags"],
            "csize": block["csize"],
            "fsize": block["fsize"],
        })
    for name in names:
        index = archive._block_for(name)
        if index is None:
            continue
        block = archive.blocks[index]
        try:
            data = archive.read_block(index)
            entries.append({"name": name, "data": data})
        except Exception as exc:
            raw, block = archive.read_raw(name)
            entries.append({
                "name": name,
                "raw": raw,
                "flags": block["flags"],
                "csize": block["csize"],
                "fsize": block["fsize"],
            })
            failed.append({"name": name, "reason": str(exc)})
    return entries, failed


# --------------------------------------------------------------- commands


def cmd_list(args):
    archive = MPQ(args[0])
    return {
        "archive": args[0],
        "version": archive.version,
        "sectorSize": archive.sector_size,
        "count": len(archive.names),
        "files": sorted(archive.names, key=str.lower),
    }


def cmd_info(args):
    archive = MPQ(args[0])
    return {
        "archive": args[0],
        "version": archive.version,
        "sectorShift": archive.sector_shift,
        "sectorSize": archive.sector_size,
        "blocks": archive.block_count,
        "hashSize": archive.hash_size,
        "size": os.path.getsize(args[0]),
        "namedFiles": len(archive.names),
    }


def cmd_read(args):
    archive = MPQ(args[0])
    data = archive.read_file(args[1])
    if "--out" in args:
        out = args[args.index("--out") + 1]
        with open(out, "wb") as fh:
            fh.write(data)
        return {"name": args[1], "bytes": len(data), "out": out}
    try:
        return {"name": args[1], "bytes": len(data), "encoding": "utf-8",
                "text": data.decode("utf-8-sig")}
    except UnicodeDecodeError:
        return {"name": args[1], "bytes": len(data), "encoding": "binary"}


def cmd_repack(args):
    src, dst = args[0], args[1]
    replace, add, delete = {}, {}, set()
    i = 2
    while i < len(args):
        flag = args[i]
        if flag in ("--replace", "--add"):
            spec = args[i + 1]
            name, _, file = spec.partition("=")
            with open(file, "rb") as fh:
                target = replace if flag == "--replace" else add
                target[name] = fh.read()
            i += 2
        elif flag == "--delete":
            delete.add(args[i + 1])
            i += 2
        else:
            i += 1

    archive = MPQ(src)
    entries, failed = collect(archive)
    kept = [e for e in entries if e["name"] not in delete and e["name"] not in replace]
    kept.extend({"name": name, "data": data} for name, data in replace.items())
    kept.extend({"name": name, "data": data} for name, data in add.items())

    names = [e["name"] for e in kept if e["name"] != "(listfile)"]
    listing = ("\r\n".join(sorted(names)) + "\r\n").encode("utf-8", "replace")
    kept = [e for e in kept if e["name"] != "(listfile)"]
    kept.append({"name": "(listfile)", "data": listing})

    info = write_archive(dst, kept)
    info["passthrough"] = failed
    return info


def cmd_pack(args):
    src, dst = args[0], args[1]
    blobs = {}
    for dirpath, _dirnames, filenames in os.walk(src):
        for filename in filenames:
            full = os.path.join(dirpath, filename)
            rel = os.path.relpath(full, src).replace(os.sep, "\\")
            with open(full, "rb") as fh:
                blobs[rel] = fh.read()
    names = sorted(blobs.keys())
    blobs["(listfile)"] = ("\r\n".join(names) + "\r\n").encode("utf-8", "replace")
    return write_archive(dst, [{"name": n, "data": d} for n, d in blobs.items()])


def cmd_unpack(args):
    archive = MPQ(args[0])
    out_dir = args[1]
    filt = None
    if "--filter" in args:
        filt = args[args.index("--filter") + 1].lower()
    written = []
    errors = []
    for name in archive.names:
        if filt and filt not in name.lower():
            continue
        target = os.path.join(out_dir, name.replace("\\", os.sep))
        os.makedirs(os.path.dirname(target), exist_ok=True)
        try:
            data = archive.read_file(name)
        except Exception as exc:
            errors.append({"name": name, "error": str(exc)})
            continue
        with open(target, "wb") as fh:
            fh.write(data)
        written.append(name)
    return {"out": out_dir, "written": len(written), "errors": errors}


def cmd_replace(args):
    archive_path, name, source = args[0], args[1], args[2]
    with open(source, "rb") as fh:
        data = fh.read()
    info = replace_file(archive_path, name, data)
    info["backup"] = None
    return info


def main(argv):
    # Windows consoles default to a legacy code page; the protocol is UTF-8.
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass
    handlers = {
        "list": cmd_list,
        "info": cmd_info,
        "read": cmd_read,
        "repack": cmd_repack,
        "pack": cmd_pack,
        "unpack": cmd_unpack,
        "replace": cmd_replace,
    }
    if len(argv) < 2 or argv[1] not in handlers:
        print(json.dumps({"ok": False, "error": "usage: mpqtool.py <%s> ..." % "|".join(handlers)}))
        return 2
    try:
        result = handlers[argv[1]](argv[2:])
        print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
