"""Reference-aware cleanup of library-owned copies, never linked source files."""
from __future__ import annotations

import re
import time
from pathlib import Path


def data_root(conn):
    return Path(conn.execute('PRAGMA database_list').fetchone()[2]).resolve().parent


def source_path(row, root):
    if row['external_path']:
        return Path(row['external_path']).resolve()
    value = str(row['path']).replace('\\', '/')
    return ((root.parent if value.startswith('原图/') else root) / value).resolve()


def owned_path(path, root):
    path = Path(path)
    resolved = path.resolve()
    for base in (root / 'media', root / 'thumbs', root.parent / '原图'):
        # Do not follow a redirected media root or an escaping symlink/junction.
        if base.resolve() != base.absolute():
            continue
        if resolved != base and resolved.is_relative_to(base):
            return resolved
    return None


def fingerprint(path):
    stat = path.stat()
    return [stat.st_size, stat.st_mtime_ns]


def unused_plan(conn, asset_ids=None, *, loose=False):
    root = data_root(conn)
    rows = conn.execute('SELECT * FROM assets').fetchall()
    linked = {row[0] for row in conn.execute('SELECT DISTINCT asset_id FROM entry_images JOIN entries ON entries.id=entry_images.entry_id')}
    legacy = conn.execute('SELECT images.path,images.thumbnail_path,images.sha256 FROM images JOIN entries ON entries.id=images.entry_id').fetchall()
    legacy_hashes = {row['sha256'] for row in legacy}
    protected = set()
    registered = set()
    for row in rows:
        paths = [source_path(row, root)]
        if row['thumbnail_path']:
            paths.append((root / row['thumbnail_path']).resolve())
        registered.update(paths)
        if row['id'] in linked or row['sha256'] in legacy_hashes:
            protected.update(paths)
        if row['external_path']:
            protected.add(paths[0])
    for row in legacy:
        protected.add(source_path({**dict(row), 'external_path': None}, root))
        if row['thumbnail_path']:
            protected.add((root / row['thumbnail_path']).resolve())
    candidates = []
    files = {}
    external_kept = 0
    selected = set(asset_ids) if asset_ids is not None else None
    for row in rows:
        if row['id'] in linked or row['sha256'] in legacy_hashes or (selected is not None and row['id'] not in selected):
            continue
        candidates.append(row['id'])
        external_kept += bool(row['external_path'])
        paths = [] if row['external_path'] else [source_path(row, root)]
        if row['thumbnail_path']:
            paths.append(root / row['thumbnail_path'])
        for path in paths:
            target = owned_path(path, root)
            if target and target not in protected and target.is_file():
                files[str(target)] = fingerprint(target)
    if loose:
        for base in (root / 'media', root / 'thumbs', root.parent / '原图'):
            if not base.is_dir() or base.resolve() != base.absolute():
                continue
            for path in base.rglob('*'):
                target = owned_path(path, root)
                # Generated originals and thumbnails use SHA-256 names. Ignore unknown
                # user files and recent writes that may belong to an in-flight import.
                if (not target or target in registered or target in protected or not target.is_file()
                        or not re.fullmatch(r'[a-fA-F0-9]{64}', target.stem)):
                    continue
                signature = fingerprint(target)
                if signature[1] / 1e9 > time.time() - 600:
                    continue
                files[str(target)] = signature
    return {'asset_ids': candidates, 'files': files, 'external_kept': external_kept,
            'bytes': sum(signature[0] for signature in files.values())}


def clean_unused(conn, plan):
    # Caller holds a write transaction: an upload cannot acquire a new reference
    # between this recheck and deletion. A preview never authorizes new candidates.
    conn.execute('DELETE FROM entry_images WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id=entry_images.entry_id)')
    conn.execute('DELETE FROM images WHERE NOT EXISTS (SELECT 1 FROM entries WHERE entries.id=images.entry_id)')
    current = unused_plan(conn, plan['asset_ids'], loose=True if plan.get('loose') else False)
    allowed = current['files']
    removed = removed_bytes = skipped = 0
    failures = []
    blocked = set()
    for raw, signature in plan['files'].items():
        path = owned_path(raw, data_root(conn))
        if not path or raw not in allowed or signature != allowed[raw]:
            skipped += 1
            blocked.add(raw)
            continue
        try:
            if not path.is_file() or fingerprint(path) != signature:
                skipped += 1
                blocked.add(raw)
                continue
            path.unlink()
            removed += 1
            removed_bytes += signature[0]
        except OSError as error:
            failures.append({'path': raw, 'error': str(error)})
            blocked.add(raw)
    removed_assets = 0
    root = data_root(conn)
    for asset_id in current['asset_ids']:
        row = conn.execute('SELECT * FROM assets WHERE id=?', (asset_id,)).fetchone()
        paths = [str(source_path(row, root))]
        if row['thumbnail_path']:
            paths.append(str((root / row['thumbnail_path']).resolve()))
        # Leave failed assets available for a later cleanup retry.
        if any(path in blocked for path in paths):
            continue
        removed_assets += conn.execute('DELETE FROM assets WHERE id=?', (asset_id,)).rowcount
    return {'removed_files': removed, 'removed_bytes': removed_bytes, 'removed_assets': removed_assets,
            'skipped': skipped, 'errors': failures, 'external_kept': current['external_kept']}


def cleanup_detached(conn, asset_ids):
    if not asset_ids:
        return {'removed_files': 0, 'removed_bytes': 0, 'removed_assets': 0, 'errors': []}
    return clean_unused(conn, unused_plan(conn, asset_ids))
