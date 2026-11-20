import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np

spec = importlib.util.spec_from_file_location("cloud_generate", Path(__file__).parents[1] / "cloud/generate.py")
cloud = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cloud)


def test_vector_cache_preserves_batch_order_and_reuses_results(tmp_path):
    requests = []

    def respond(request):
        requests.append(request)
        assert request.url.path == "/v1/embeddings"
        texts = json.loads(request.content)["input"]
        return httpx.Response(200, json={"data": [
            {"index": i, "embedding": [float(len(text)), 1.0]} for i, text in reversed(list(enumerate(texts)))
        ]})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        cache = cloud.VectorCache(tmp_path / "vectors.sqlite", "https://api.test/v1", "test", "key")
        try:
            first = cache.encode(["a", "bbbb"], client)
            second = cache.encode(["bbbb", "a"], client)
            assert len(requests) == 1
            np.testing.assert_allclose(first[0], second[1])
            np.testing.assert_allclose(first[1], second[0])
        finally:
            cache.close()


def test_feedback_semantics_and_author_diversity():
    config = {"topics": [{"name": "Topic A"}, {"name": "Topic B"}], "min_similarity": .2,
              "daily_limit": 4, "max_per_author": 1, "max_per_topic": 3,
              "duplicate_similarity": .9999, "exploration_slots": 1}
    articles = [{"url": f"https://blog.test/{i}", "title": str(i), "content": "source",
                 "summary": "source", "source": f"author-{i // 2}", "published_at": datetime.now(UTC).isoformat()}
                for i in range(6)]
    vectors = np.array([[1., 0.], [.99, .1], [.8, .6], [.6, .8], [.1, .99], [0., 1.]])
    vectors /= np.linalg.norm(vectors, axis=1, keepdims=True)
    topics = np.eye(2)
    feedback = [{"url": articles[0]["url"], "verdict": "known", "is_read": 1}]
    selected = cloud.select(config, articles, vectors, topics, feedback, "2026-11-20")
    assert articles[0]["url"] not in {a["url"] for a in selected}
    assert len({a["source"] for a in selected}) == len(selected)
    assert all(a["category"] in ["Topic A", "Topic B"] for a in selected)
    # Quality/known feedback must not become a broad topic dislike.
    feedback[0]["verdict"] = "quality"
    assert [a["url"] for a in selected] == [a["url"] for a in cloud.select(config, articles, vectors, topics, feedback, "2026-11-20")]


def test_feed_excerpt_removes_markup_and_scripts():
    assert cloud.plain('<p>Hello &amp; world</p><script>bad()</script><p>Source</p>') == 'Hello & world Source'
