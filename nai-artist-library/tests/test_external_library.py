from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from database import connect
from external_library import _register_custom_sources, _source_terms_confirmed, _thumbnail_rel, _upsert_entries, _upsert_source


class ExternalLibraryTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "library.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_upsert_preserves_user_data_and_valid_thumbnail(self):
        with connect(self.db_path) as conn:
            _upsert_source(conn, {"id": "demo", "provider": "test", "title": "Demo"})
            _upsert_entries(conn, "demo", [{
                "id": "one", "title": "First", "prompt": "blue dress",
                "images": [{"url": "https://example.test/one.jpg", "revision": "v1"}],
            }])
            conn.execute(
                "UPDATE external_entry_images SET thumb_path='external-libraries/thumbnails/demo/one.webp' "
                "WHERE source_id='demo' AND external_id='one'"
            )
            conn.execute(
                "INSERT INTO external_user_data(source_id,external_id,favorite,personal_note,updated_at) "
                "VALUES('demo','one',1,'mine','now')"
            )
            _upsert_entries(conn, "demo", [{
                "id": "one", "title": "Renamed", "prompt": "red dress",
                "images": [{"url": "https://example.test/one.jpg", "revision": "v1"}],
            }])
            row = conn.execute(
                "SELECT e.title,e.prompt,i.thumb_path,u.favorite,u.personal_note FROM external_entries e "
                "JOIN external_entry_images i USING(source_id,external_id) "
                "JOIN external_user_data u USING(source_id,external_id)"
            ).fetchone()
        self.assertEqual(tuple(row), (
            "Renamed", "red dress", "external-libraries/thumbnails/demo/one.webp", 1, "mine"
        ))

    def test_changed_revision_invalidates_thumbnail(self):
        with connect(self.db_path) as conn:
            _upsert_source(conn, {"id": "demo", "provider": "test", "title": "Demo"})
            _upsert_entries(conn, "demo", [{"id": "one", "images": [{"url": "https://x/a.jpg", "revision": "1"}]}])
            conn.execute("UPDATE external_entry_images SET thumb_path='old.webp'")
            _upsert_entries(conn, "demo", [{"id": "one", "images": [{"url": "https://x/a.jpg", "revision": "2"}]}])
            value = conn.execute("SELECT thumb_path FROM external_entry_images").fetchone()[0]
        self.assertEqual(value, "")

    def test_thumbnail_name_is_stable_and_contains_no_original_extension(self):
        first = _thumbnail_rel("source:one", "entry", 0, "https://x/image.png")
        second = _thumbnail_rel("source:one", "entry", 0, "https://x/image.png")
        self.assertEqual(first, second)
        self.assertTrue(first.endswith(".webp"))
        self.assertNotIn(".png", first)

    def test_clean_install_has_no_built_in_sources(self):
        with patch("external_library._custom_sources", return_value=[]), connect(self.db_path) as conn:
            _register_custom_sources(conn)
            count = conn.execute("SELECT COUNT(*) FROM external_sources").fetchone()[0]
        self.assertEqual(count, 0)

    def test_only_user_configured_source_is_registered(self):
        config = {"id": "custom:mine", "title": "My data", "catalog_url": "https://example.test/data.json",
                  "source_url": "https://example.test/", "author": "", "description": "", "nsfw": False}
        with patch("external_library._custom_sources", return_value=[config]), connect(self.db_path) as conn:
            _register_custom_sources(conn)
            rows = conn.execute("SELECT id,provider,title FROM external_sources").fetchall()
        self.assertEqual([tuple(row) for row in rows], [("custom:mine", "generic", "My data")])

    def test_source_terms_require_explicit_boolean_confirmation(self):
        self.assertTrue(_source_terms_confirmed({"terms_confirmed": True}))
        for payload in [None, {}, {"terms_confirmed": False}, {"terms_confirmed": "true"}, []]:
            self.assertFalse(_source_terms_confirmed(payload))


if __name__ == "__main__":
    unittest.main()
