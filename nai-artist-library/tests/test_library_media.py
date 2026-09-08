from __future__ import annotations

import os
import tempfile
import time
import unittest
from functools import partial
from pathlib import Path
from unittest.mock import patch

from app import app
from database import connect, init_db
from library_media import clean_unused, unused_plan


class LibraryMediaTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name) / 'data'
        self.root.mkdir()
        self.db = self.root / 'library.db'
        init_db(self.db)
        self.patch = patch('app.connect', partial(connect, self.db))
        self.patch.start()
        self.addCleanup(self.patch.stop)
        app.config.update(TESTING=True)
        self.client = app.test_client()

    def wait_cleanup(self, response):
        cleanup = response.get_json()['cleanup']
        if not cleanup.get('queued'):
            return cleanup
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = self.client.get('/api/jobs/' + cleanup['job_id']).get_json()
            if job['status'] in ('completed', 'failed'):
                self.assertEqual(job['status'], 'completed', job)
                return job['result']
            time.sleep(0.02)
        self.fail('cleanup timed out')

    def entry(self):
        return self.client.post('/api/entries', json={'kind': 'prompt', 'title': '测试', 'content': 'test'}).get_json()['id']

    def asset(self, entries=(), external=None, name='test.png'):
        original = self.root / 'media' / name
        thumb = self.root / 'thumbs' / name
        original.parent.mkdir(exist_ok=True)
        thumb.parent.mkdir(exist_ok=True)
        original.write_bytes(b'original')
        thumb.write_bytes(b'thumbnail')
        with connect(self.db) as conn:
            asset_id = conn.execute(
                'INSERT INTO assets(path,thumbnail_path,external_path,sha256,created_at) VALUES(?,?,?,?,?)',
                (f'media/{name}', f'thumbs/{name}', str(external) if external else None, name, '2026-09-06'),
            ).lastrowid
            conn.executemany('INSERT INTO entry_images(entry_id,asset_id) VALUES(?,?)', [(entry, asset_id) for entry in entries])
        return asset_id, original, thumb

    def test_shared_image_is_removed_only_after_last_reference(self):
        first, second = self.entry(), self.entry()
        asset_id, original, thumb = self.asset([first, second])
        response = self.client.delete(f'/api/entries/{first}/images/{asset_id}')
        self.assertEqual(response.status_code, 200)
        self.wait_cleanup(response)
        self.assertTrue(original.exists())
        self.assertTrue(thumb.exists())
        response = self.client.delete(f'/api/entries/{second}')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.wait_cleanup(response)['removed_files'], 2)
        self.assertFalse(original.exists())
        self.assertFalse(thumb.exists())

    def test_batch_deletes_copies_but_not_external_source(self):
        first, second = self.entry(), self.entry()
        source = Path(self.folder.name) / 'outside.png'
        source.write_bytes(b'keep me')
        _, original, thumb = self.asset([first])
        _, _, external_thumb = self.asset([second], external=source, name='external.png')
        response = self.client.post('/api/entries/batch-delete', json={'ids': [first, second]})
        self.assertEqual(response.status_code, 200)
        self.wait_cleanup(response)
        self.assertFalse(original.exists())
        self.assertFalse(thumb.exists())
        self.assertFalse(external_thumb.exists())
        self.assertEqual(source.read_bytes(), b'keep me')

    def test_preview_does_not_delete_and_cleanup_rechecks_new_references(self):
        asset_id, original, thumb = self.asset()
        with connect(self.db) as conn:
            plan = unused_plan(conn)
        self.assertTrue(original.exists())
        entry = self.entry()
        with connect(self.db) as conn:
            conn.execute('INSERT INTO entry_images(entry_id,asset_id) VALUES(?,?)', (entry, asset_id))
            result = clean_unused(conn, plan)
        self.assertEqual(result['removed_files'], 0)
        self.assertTrue(original.exists())
        self.assertTrue(thumb.exists())

    def test_changed_file_after_preview_is_not_deleted(self):
        _, original, _ = self.asset()
        with connect(self.db) as conn:
            plan = unused_plan(conn)
        original.write_bytes(b'changed after preview')
        with connect(self.db) as conn:
            conn.execute('BEGIN IMMEDIATE')
            result = clean_unused(conn, plan)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM assets').fetchone()[0], 1)
        self.assertGreater(result['skipped'], 0)
        self.assertTrue(original.exists())

    def test_unregistered_cleanup_only_targets_old_generated_names(self):
        media = self.root / 'media'
        media.mkdir()
        old = media / ('a' * 64 + '.png')
        recent = media / ('b' * 64 + '.png')
        manual = media / 'my-picture.png'
        for path in (old, recent, manual):
            path.write_bytes(b'test')
        os.utime(old, (time.time() - 3600, time.time() - 3600))
        with connect(self.db) as conn:
            plan = unused_plan(conn, loose=True)
            plan['loose'] = True
            self.assertEqual(len(plan['files']), 1)
            conn.execute('BEGIN IMMEDIATE')
            clean_unused(conn, plan)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())
        self.assertTrue(manual.exists())

    def test_escaping_paths_and_external_paths_inside_media_are_protected(self):
        external = self.root / 'media' / 'external.png'
        _, _, thumb = self.asset(external=external, name='external.png')
        outside = Path(self.folder.name) / 'outside.png'
        outside.write_bytes(b'keep')
        with connect(self.db) as conn:
            conn.execute('INSERT INTO assets(path,thumbnail_path,sha256,created_at) VALUES(?,?,?,?)',
                         ('../outside.png', '../outside.png', 'escape', '2026-09-06'))
            conn.execute('BEGIN IMMEDIATE') if not conn.in_transaction else None
            clean_unused(conn, unused_plan(conn))
        self.assertTrue(external.exists())
        self.assertTrue(outside.exists())
        self.assertFalse(thumb.exists())

    def test_failed_deletion_is_reported_and_can_be_retried(self):
        _, original, _ = self.asset()
        with connect(self.db) as conn:
            conn.execute('BEGIN IMMEDIATE')
            with patch.object(Path, 'unlink', side_effect=PermissionError('in use')):
                result = clean_unused(conn, unused_plan(conn))
            self.assertEqual(len(result['errors']), 2)
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM assets').fetchone()[0], 1)
        self.assertTrue(original.exists())

    def test_cleanup_job_requires_valid_preview(self):
        response = self.client.post('/api/library-maintenance/jobs', json={'operation': 'cleanup', 'token': 'missing'})
        self.assertEqual(response.status_code, 409)

    def test_incremental_deletion_cleans_images_and_foreign_keys(self):
        from docx_database_converter import apply_incremental_update
        entry = self.entry()
        _, original, thumb = self.asset([entry])
        plan, backup = apply_incremental_update(self.db, 'prompt', [], delete_missing=True,
                                                backup_dir=Path(self.folder.name) / 'backups')
        self.assertEqual(plan['media_cleanup']['removed_files'], 2)
        self.assertTrue(backup.exists())
        self.assertFalse(original.exists())
        self.assertFalse(thumb.exists())
        with connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM entry_images').fetchone()[0], 0)

    def test_legacy_unlink_does_not_resurrect_or_keep_copy(self):
        entry = self.entry()
        asset_id, original, _ = self.asset([entry])
        with connect(self.db) as conn:
            conn.execute('INSERT INTO images(entry_id,path,sha256) VALUES(?,?,?)', (entry, 'media/test.png', 'test.png'))
        response = self.client.delete(f'/api/entries/{entry}/images/{asset_id}')
        self.assertEqual(response.status_code, 200)
        self.wait_cleanup(response)
        self.assertFalse(original.exists())
        with connect(self.db) as conn:
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM images').fetchone()[0], 0)

    def test_card_commits_before_files_are_cleaned(self):
        from media_cleanup_queue import drain_cleanup
        entry = self.entry()
        _, original, thumb = self.asset([entry])
        with patch('app.schedule_media_cleanup', return_value={'queued': True}):
            response = self.client.delete(f'/api/entries/{entry}')
        self.assertEqual(response.status_code, 200)
        with connect(self.db) as conn:
            self.assertIsNone(conn.execute('SELECT id FROM entries WHERE id=?', (entry,)).fetchone())
            self.assertEqual(conn.execute('SELECT COUNT(*) FROM media_cleanup_queue').fetchone()[0], 1)
        self.assertTrue(original.exists())
        self.assertEqual(drain_cleanup(self.db)['removed_files'], 2)
        self.assertFalse(original.exists())
        self.assertFalse(thumb.exists())

    def test_queued_cleanup_rechecks_references(self):
        from media_cleanup_queue import drain_cleanup
        entry = self.entry()
        asset_id, original, thumb = self.asset([entry])
        with patch('app.schedule_media_cleanup', return_value={'queued': True}):
            self.client.delete(f'/api/entries/{entry}')
        replacement = self.entry()
        with connect(self.db) as conn:
            conn.execute('INSERT INTO entry_images(entry_id,asset_id) VALUES(?,?)', (replacement, asset_id))
        self.assertEqual(drain_cleanup(self.db)['removed_files'], 0)
        self.assertTrue(original.exists())
        self.assertTrue(thumb.exists())

    def test_preview_and_cleanup_jobs_use_isolated_database(self):
        _, original, _ = self.asset()
        def wait(job_id):
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline:
                job = self.client.get(f'/api/jobs/{job_id}').get_json()
                if job['status'] in ('completed', 'failed'):
                    self.assertEqual(job['status'], 'completed', job)
                    return job['result']
                time.sleep(0.02)
            self.fail('maintenance job timed out')
        preview = self.client.post('/api/library-maintenance/jobs', json={'operation': 'preview'})
        self.assertEqual(preview.status_code, 202)
        result = wait(preview.get_json()['id'])
        self.assertEqual(result['files'], 2)
        self.assertTrue(original.exists())
        cleanup = self.client.post('/api/library-maintenance/jobs', json={'operation': 'cleanup', 'token': result['token']})
        self.assertEqual(cleanup.status_code, 202)
        self.assertEqual(wait(cleanup.get_json()['id'])['removed_files'], 2)
        self.assertFalse(original.exists())


if __name__ == '__main__':
    unittest.main()
