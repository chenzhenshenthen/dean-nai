"""No live user database: discrete ratings and gallery search grammar."""
import sqlite3
import unittest
from werkzeug.datastructures import MultiDict
from werkzeug.exceptions import BadRequest
from app import app, entry_filters
from gallery_search import gallery_search_clauses


class SearchTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE local_images(id INTEGER PRIMARY KEY)")
        self.db.execute("CREATE VIRTUAL TABLE local_images_fts USING fts5(prompt)")
        prompts = ["cat blue hair", "dog blue eyes", "cat dog red text", "blue hair", "dog blue hair text"]
        for index, prompt in enumerate(prompts, 1):
            self.db.execute("INSERT INTO local_images VALUES(?)", (index,))
            self.db.execute("INSERT INTO local_images_fts(rowid,prompt) VALUES(?,?)", (index, prompt))

    def search(self, query):
        clauses, params = gallery_search_clauses(query)
        return [row[0] for row in self.db.execute("SELECT id FROM local_images" + (" WHERE " + " AND ".join(clauses) if clauses else "") + " ORDER BY id", params)]

    def test_space_is_or(self):
        self.assertEqual(self.search("cat dog"), [1, 2, 3, 5])

    def test_required_and_excluded(self):
        self.assertEqual(self.search("cat dog +blue -text"), [1, 2])
        self.assertEqual(self.search("+dog +blue"), [2, 5])

    def test_negative_only(self):
        self.assertEqual(self.search("-text"), [1, 2, 4])

    def test_quoted_phrases_and_prefix(self):
        self.assertEqual(self.search('"blue hair" -dog'), [1, 4])
        self.assertEqual(self.search("blu"), [1, 2, 4, 5])

    def test_empty_and_invalid(self):
        self.assertEqual(self.search("  "), [1, 2, 3, 4, 5])
        for query in ['"unfinished', '+', '-', 'a ' * 65, 'a' * 2001]:
            with self.subTest(query=query), self.assertRaises(ValueError):
                self.search(query)

    def test_fts_operators_are_literals(self):
        self.assertEqual(self.search("OR"), [])
        self.assertEqual(self.search("cat OR dog"), [1, 2, 3, 5])


class RatingTest(unittest.TestCase):
    def selected(self, values, **extra):
        with app.test_request_context():
            _, where, params = entry_filters(MultiDict({"kind": "artist", "ratings": values, **extra}))
        with sqlite3.connect(":memory:") as db:
            db.execute("CREATE TABLE entries(kind TEXT,rating INTEGER)")
            db.executemany("INSERT INTO entries VALUES('artist',?)", [(None,), *[(n,) for n in range(1, 11)]])
            return [row[0] for row in db.execute("SELECT rating FROM entries WHERE " + where + " ORDER BY rating", params)]

    def test_half_star_and_five(self):
        self.assertEqual(self.selected("9,10"), [9, 10])

    def test_only_five(self):
        self.assertEqual(self.selected("10"), [10])

    def test_non_contiguous_and_legacy_precedence(self):
        self.assertEqual(self.selected("8,10", rating_min="9", rating_max="9"), [8, 10])

    def test_unrated_and_duplicates(self):
        self.assertEqual(self.selected("unrated,10,10"), [None, 10])

    def test_reject_invalid(self):
        with self.assertRaises(BadRequest):
            self.selected("11")


if __name__ == "__main__":
    unittest.main()
