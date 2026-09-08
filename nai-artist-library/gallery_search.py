"""Explicit OR / required / excluded grammar, compiled to bound FTS5 queries."""
import re

TOKEN = re.compile(r'\s*([+-]?)(?:"((?:\\.|[^"\\])*)"|([^\s"]+))')


def gallery_search_clauses(query):
    if len(query) > 2000:
        raise ValueError("搜索内容过长，最多 2000 字符")
    groups = {"": [], "+": [], "-": []}
    position = 0
    count = 0
    while position < len(query.rstrip()):
        match = TOKEN.match(query, position)
        if not match:
            raise ValueError('搜索引号不完整；词组请使用 "blue hair" 格式')
        sign, phrase, word = match.groups()
        value = re.sub(r'\\(["\\])', r'\1', phrase) if phrase is not None else word
        if not value or value in {"+", "-"}:
            raise ValueError("+ 或 - 后面需要紧跟搜索词")
        encoded = '"' + value.replace('"', '""') + '"' + ("*" if phrase is None else "")
        groups[sign].append(encoded)
        position = match.end()
        count += 1
        if count > 64:
            raise ValueError("一次最多搜索 64 个条件")
    clauses, params = [], []
    subquery = "SELECT rowid FROM local_images_fts WHERE local_images_fts MATCH ?"
    if groups[""]:
        clauses.append("id IN (" + subquery + ")")
        params.append(" OR ".join(groups[""]))
    for word in groups["+"]:
        clauses.append("id IN (" + subquery + ")")
        params.append(word)
    if groups["-"]:
        clauses.append("id NOT IN (" + subquery + ")")
        params.append(" OR ".join(groups["-"]))
    return clauses, params
