"""Prepare source excerpts without loading a model or making API calls."""

import re
from html import escape, unescape
from typing import Any

from condenseit.digest.format import build_digest_markdown
from condenseit.providers.base import ArticleSummary, SummarizerProvider


class ExcerptProvider(SummarizerProvider):
    @property
    def model_name(self) -> str:
        return "Source excerpts (no AI summaries)"

    def summarize_article(self, article: dict[str, Any]) -> ArticleSummary:
        content = str(article.get("content") or article.get("description") or "")
        text = " ".join(unescape(re.sub(r"<[^>]+>", " ", content)).split())
        excerpt = text[:800] + ("…" if len(text) > 800 else "")
        return ArticleSummary(
            summary=excerpt,
            tldr="",
            key_takeaways=[],
            topics=[],
            entities=[],
            novelty=0,
            relevance_to_you="",
        )

    def generate_digest(
        self,
        categorized: dict[str, list[dict[str, Any]]],
        changes: list[dict[str, str]] | None = None,
        videos: list[dict[str, Any]] | None = None,
    ) -> str:
        def escaped(item: dict[str, Any]) -> dict[str, Any]:
            return {
                **item,
                "summary": escape(str(item.get("summary") or "")),
                "title": escape(str(item.get("title") or "")),
            }

        return build_digest_markdown(
            {
                category: [escaped(item) for item in items]
                for category, items in categorized.items()
            },
            changes,
            [escaped(item) for item in videos] if videos else None,
        )
