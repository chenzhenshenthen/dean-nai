"""Copy/paste cleanup for official NovelAI tokens; never log credential values."""
import re


def normalize_novelai_token(raw: str) -> str:
    value = raw.strip()
    for _ in range(4):
        previous = value
        if (value.startswith('"') and value.endswith('"')) or (value.startswith("'") and value.endswith("'")):
            value = value[1:-1].strip()
        value = re.sub(r"^Bearer\s+", "", value, count=1, flags=re.IGNORECASE).strip()
        if value == previous:
            break
    return re.sub(r"\s+", "", value)


def has_novelai_token_format(token: str) -> bool:
    return (token.startswith("pst-") and 4 < len(token) <= 4096
            and not re.search(r"[\s\"'*•…]", token) and "..." not in token)
