from datetime import UTC, datetime

import httpx
from fastapi.testclient import TestClient

from condenseit.collectors.rss import CollectedArticle, RSSCollector
from condenseit.pipeline import orchestrator
from condenseit.services import digest_runner
from condenseit.store.database import ContentStore
from condenseit.web.app import create_app


def test_normal_digest_uses_excerpts_and_embeddings_without_chat(monkeypatch, tmp_path):
    monkeypatch.setenv("CONDENSEIT_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("CONDENSEIT_OTEL_ENABLED", "false")
    config = tmp_path / "config.yaml"
    config.write_text(
        "feeds:\n  - url: https://example.test/feed\n"
        "llm:\n  provider: ollama\n"
        "relevance:\n  llm_rerank_enabled: true\n"
        "balance_digest_categories: false\n",
        encoding="utf-8",
    )
    store = ContentStore()
    store.set_setting("summarization_enabled", "0")
    store.close()

    def forbidden(*args, **kwargs):
        raise AssertionError("No network, chat reranking or Ollama process expected")

    monkeypatch.setattr(httpx.Client, "send", forbidden)
    monkeypatch.setattr(digest_runner, "OllamaLifecycle", forbidden)
    monkeypatch.setattr(orchestrator, "rerank", forbidden)

    class Embeddings:
        model_name = "test-embedding"
        calls = 0

        def embed(self, text):
            self.calls += 1
            return [1.0, 0.0] if "Memory" in text else [0.0, 1.0]

    embeddings = Embeddings()
    monkeypatch.setattr(
        orchestrator, "build_embedding_provider", lambda *a, **k: embeddings
    )
    now = datetime.now(UTC).isoformat()
    articles = [
        CollectedArticle(
            url="https://example.test/memory",
            title="Memory practice",
            content="<p>Original article &amp; source excerpt.</p>",
            source="Personal blog",
            category="Education",
            published_at=now,
            content_hash="memory",
        ),
        CollectedArticle(
            url="https://example.test/software",
            title="Open software",
            content="A different original article about software.",
            source="Personal blog",
            category="Computing",
            published_at=now,
            content_hash="software",
        ),
    ]
    monkeypatch.setattr(
        RSSCollector,
        "collect_feed_results",
        lambda self: [(self.feeds[0], articles, None)],
    )
    result = digest_runner.execute_digest(str(config), skip_deploy=True)
    stats = result["stats"]
    assert stats["dry_run"] is False
    assert stats["summarization_enabled"] is False
    assert "llama" not in stats["model"]
    assert stats["embedding_model"] == "test-embedding"
    assert embeddings.calls == 2
    assert stats["articles_count"] == 2
    memory = next(i for i in stats["digest_items"] if i["title"] == "Memory practice")
    assert memory["summary"] == "Original article & source excerpt."
    assert memory["summary_kind"] == "excerpt"
    assert memory["key_takeaways"] == []
    store = ContentStore()
    try:
        assert store.latest_digest()["id"] == result["digest_id"]
        assert store.db["article_embeddings"].count == 2
    finally:
        store.close()


def test_summary_setting_roundtrip_and_validation(monkeypatch, tmp_path):
    monkeypatch.setenv("CONDENSEIT_DATA_DIR", str(tmp_path / "data"))
    config = tmp_path / "config.yaml"
    config.write_text("feeds: []\n", encoding="utf-8")
    client = TestClient(create_app(str(config)))
    headers = {"Authorization": "Bearer condenseit"}
    for enabled in [False, True, False]:
        response = client.put(
            "/api/config/digest",
            json={"summarization_enabled": enabled},
            headers=headers,
        )
        assert response.status_code == 200
        effective = client.get("/api/config/digest", headers=headers).json()
        assert effective["summarization_enabled"] is enabled
    response = client.put(
        "/api/config/digest",
        json={"summarization_enabled": "false"},
        headers=headers,
    )
    assert response.status_code == 422
