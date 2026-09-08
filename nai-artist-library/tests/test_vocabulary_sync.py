from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from database import connect
from vocabulary_sync import (
    CATEGORY_NAMES,
    apply_remote_tags,
    set_translation,
    sync_global_incremental,
    sync_scope,
    sync_status,
)


def remote_tag(tag_id: int, name: str, *, count: int = 10, category: int = 4, deprecated: bool = False):
    return {
        "id": tag_id,
        "name": name,
        "post_count": count,
        "category": category,
        "is_deprecated": deprecated,
        "created_at": "2026-08-31T00:00:00Z",
        "updated_at": "2026-08-31T00:00:00Z",
    }


class VocabularySyncTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "library.sqlite3"

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_remote_tags_merge_without_source_files(self):
        with connect(self.db_path) as conn:
            result = apply_remote_tags(
                conn,
                [remote_tag(101, "new_character_(example_work)", count=42)],
                source_scope="example_work",
            )
            row = conn.execute(
                "SELECT hot, category, source_file FROM vocabulary_tags WHERE name = ?",
                ("new_character_(example_work)",),
            ).fetchone()
        self.assertEqual(result["inserted"], 1)
        self.assertEqual(tuple(row), (42, CATEGORY_NAMES[4], "danbooru-live:example_work"))

    def test_manual_translation_survives_builtin_seed(self):
        with connect(self.db_path) as conn:
            apply_remote_tags(
                conn,
                [remote_tag(102, "rover_(wuthering_waves)")],
                source_scope="wuthering_waves",
            )
            set_translation(conn, "rover_(wuthering_waves)", "custom translation")
            sync_status(conn)
            translation = conn.execute(
                "SELECT translation FROM vocabulary_tags WHERE name = ?",
                ("rover_(wuthering_waves)",),
            ).fetchone()[0]
        self.assertEqual(translation, "custom translation")

    def test_scope_sync_does_not_stop_on_deprecated_item(self):
        first_page = [
            remote_tag(index + 1, f"character_{index}_(example_work)", deprecated=index == 0)
            for index in range(200)
        ]
        second_page = [remote_tag(300, "last_character_(example_work)")]
        with connect(self.db_path) as conn:
            with patch("vocabulary_sync._request_tags", side_effect=[first_page, second_page]):
                result = sync_scope(conn, "example_work", max_pages=3)
            exists = conn.execute(
                "SELECT COUNT(*) FROM vocabulary_tags WHERE name = 'last_character_(example_work)'"
            ).fetchone()[0]
        self.assertEqual(result["pages"], 2)
        self.assertEqual(exists, 1)

    def test_global_sync_advances_cursor_without_skipping_old_rows(self):
        with connect(self.db_path) as conn:
            with patch(
                "vocabulary_sync._request_tags",
                return_value=[
                    remote_tag(12, "newest_general", category=0),
                    remote_tag(11, "older_general", category=0),
                ],
            ):
                first = sync_global_incremental(conn)
            with patch(
                "vocabulary_sync._request_tags",
                return_value=[
                    remote_tag(13, "next_general", category=0),
                    remote_tag(12, "newest_general", category=0),
                ],
            ):
                second = sync_global_incremental(conn)
            names = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM vocabulary_tags WHERE source_file = 'danbooru-live:global'"
                )
            }
            status = sync_status(conn)
        self.assertTrue(first["bootstrap"])
        self.assertFalse(second["bootstrap"])
        self.assertEqual(second["received"], 1)
        self.assertEqual(status["last_tag_id"], 13)
        self.assertEqual(names, {"newest_general", "older_general", "next_general"})


if __name__ == "__main__":
    unittest.main()
