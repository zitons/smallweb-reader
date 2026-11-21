import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import numpy as np
import pytest

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
    assert all(a["category"] == "兴趣探索" for a in selected)
    # Quality/known feedback must not become a broad topic dislike.
    feedback[0]["verdict"] = "quality"
    assert [a["url"] for a in selected] == [a["url"] for a in cloud.select(config, articles, vectors, topics, feedback, "2026-11-20")]


def test_feed_excerpt_removes_markup_and_scripts():
    assert cloud.plain('<p>Hello &amp; world</p><script>bad()</script><p>Source</p>') == 'Hello & world Source'


def test_collection_does_not_truncate_feed_to_recommendation_limit():
    feed = '<rss version="2.0"><channel>' + ''.join(f'<item><title>Article {i}</title><link>https://blog.test/{i}</link><description>Full source excerpt {i}</description></item>' for i in range(5)) + '</channel></rss>'
    with httpx.Client(transport=httpx.MockTransport(lambda r: httpx.Response(200, text=feed))) as client:
        entries = cloud.collect({'feeds': ['https://feed.test/rss'], 'candidate_limit': 1}, client)
    assert len(entries) == 5


def test_archive_batches_every_entry_without_calling_embeddings():
    requests = []
    def respond(request):
        assert request.url.path == '/internal/ingest'
        assert request.headers['Authorization'] == 'Bearer sync'
        requests.append(json.loads(request.content)['articles'])
        return httpx.Response(200, json={'ok': True})
    articles = [{'url': f'https://blog.test/{i}'} for i in range(215)]
    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        cloud.archive_articles(client, 'https://reader.test', 'sync', articles)
    assert [len(batch) for batch in requests] == [100, 100, 15]
    assert [a for batch in requests for a in batch] == articles


def test_old_entries_are_archived_even_when_no_digest_can_be_generated(tmp_path, monkeypatch):
    old = {'url': 'https://old.test/a', 'title': 'Old', 'content': 'Source', 'source': 'old.test', 'published_at': '2020-01-01T00:00:00+00:00'}
    writes = []
    def respond(request):
        if request.url.path == '/internal/snapshot':
            return httpx.Response(200, json={'articles': [], 'feedback': []})
        assert request.url.path == '/internal/ingest', 'archive ingestion must not require embeddings or a digest'
        writes.append(json.loads(request.content)['articles'])
        return httpx.Response(200, json={'ok': True})
    client = httpx.Client(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(cloud.httpx, 'Client', lambda **kwargs: client)
    monkeypatch.setattr(cloud, 'collect', lambda config, client: [old])
    for key in ('READER_API_URL', 'READER_SYNC_TOKEN', 'SILICONFLOW_API_KEY'):
        monkeypatch.setenv(key, 'https://reader.test' if key == 'READER_API_URL' else 'test')
    path = tmp_path / 'config.yaml'
    path.write_text(json.dumps({'max_age_days': 30, 'pool_limit': 200}))
    with pytest.raises(RuntimeError, match='No recent articles'):
        cloud.generate(path)
    assert writes == [[old]]


def test_explicit_samples_replace_descriptions_and_preserve_multiple_interests():
    config = {"topics": [{"name": "Written topic"}], "min_similarity": .42,
              "daily_limit": 10, "max_per_author": 2, "max_per_topic": 3,
              "duplicate_similarity": .99, "exploration_slots": 1}
    samples = [{"url": f"https://seed-{i}.test/post", "title": f"Approved {i}",
                "source": f"seed-{i}.test", "published_at": "2020-01-01T00:00:00+00:00"}
               for i in range(10)]
    sample_vectors = np.array([[1., 0., 0.]] * 5 + [[0., 1., 0.]] * 5)
    feedback = [{"url": a["url"], "verdict": "useful", "is_read": 1} for a in samples]
    profile = cloud.build_profile(config, samples, sample_vectors, feedback)
    assert profile["metadata"]["mode"] == "personalized"
    assert profile["metadata"]["clusters"] == 2
    np.testing.assert_allclose((sample_vectors @ profile["centers"].T).max(axis=1), 1)
    candidates = [{"url": f"https://candidate-{i}.test/post", "title": title,
                   "source": f"candidate-{i}.test", "summary": title,
                   "published_at": datetime.now(UTC).isoformat()}
                  for i, title in enumerate(["Language acquisition", "Programming", "Compounding investments"])]
    vectors = np.array([[.9, 0, np.sqrt(.19)], [0, .9, np.sqrt(.19)], [0, 0, 1.]])
    selected = cloud.select(config, candidates, vectors, np.array([[0., .6, .8]]), feedback, "test", profile=profile)
    assert {a["title"] for a in selected} == {"Language acquisition", "Programming"}
    assert all(a["recommendation_basis"] == "profile" and a["reference_url"] for a in selected)
    assert all(a["category"] == "兴趣相近" for a in selected)
    assert not any(a["title"] == "Compounding investments" for a in selected)


def test_profile_uses_current_explicit_verdicts_and_caps_source_influence():
    articles = [{"url": f"https://author.test/{i}", "source": "author.test", "title": str(i)} for i in range(8)]
    vectors = np.tile([1., 0.], (8, 1))
    feedback = [{"url": a["url"], "verdict": v, "is_read": 1, "saved": 1}
                for a, v in zip(articles, [None, "known", "quality", "useful", "useful", "useful", "useful", "topic"])]
    profile = cloud.build_profile({}, articles, vectors, feedback)
    assert profile["metadata"]["positive_samples"] == 3
    assert profile["metadata"]["profile_weight"] == .3
    assert profile["metadata"]["mode"] == "learning"
    feedback = [{"url": articles[3]["url"], "verdict": "useful"}, {"url": articles[3]["url"], "verdict": None}]
    profile = cloud.build_profile({}, articles + articles, np.tile([1., 0.], (16, 1)), feedback)
    assert profile["metadata"]["positive_samples"] == 0
    assert profile["centers"] is None


def test_cold_start_ranks_without_forcing_topic_coverage_or_claiming_labels():
    config = {"topics": [{"name": "A"}, {"name": "Comprehensible input"}], "min_similarity": .42,
              "daily_limit": 1, "max_per_author": 2, "max_per_topic": 3,
              "duplicate_similarity": .99, "exploration_slots": 0}
    articles = [{"url": f"https://blog-{i}.test/post", "source": f"blog-{i}.test", "title": str(i),
                 "published_at": datetime.now(UTC).isoformat()} for i in range(2)]
    selected = cloud.select(config, articles, np.array([[.424, .1], [.1, .9]]), np.eye(2), [], "test")
    assert selected[0]["url"] == articles[1]["url"]
    assert selected[0]["category"] == "兴趣探索"
    assert "Comprehensible input" not in selected[0]["reason"]
    assert selected[0]["reference_url"] is None


@pytest.mark.parametrize('saved_topics', [None, [{'name': 'Saved interest', 'description': 'Interest description saved through the reader settings.'}]])
def test_generation_keeps_old_approved_samples_separate_from_candidates(tmp_path, monkeypatch, saved_topics):
    config = {"topics": [{"name": "Initial topic", "description": "description"}],
              "embedding": {"base_url": "https://embedding.test", "model": "test"},
              "max_age_days": 30, "pool_limit": 200, "timezone": "Asia/Shanghai",
              "min_similarity": .42, "daily_limit": 10, "max_per_author": 2,
              "max_per_topic": 3, "duplicate_similarity": .99, "profile_full_weight_samples": 1}
    old = {"url": "https://old.test/post", "title": "Approved", "content": "Old source",
           "source": "old.test", "published_at": "2020-01-01T00:00:00+00:00"}
    fresh = {"url": "https://fresh.test/post", "title": "New", "content": "Fresh source",
             "source": "fresh.test", "published_at": datetime.now(UTC).isoformat()}
    published = []

    def respond(request):
        if request.url.path == "/internal/snapshot":
            return httpx.Response(200, json={"articles": [fresh], "profile_articles": [old], "settings": {"topics": saved_topics} if saved_topics else None,
                                            "feedback": [{"url": old["url"], "verdict": "useful"}]})
        published.append(json.loads(request.content))
        return httpx.Response(200, json={"ok": True})

    class Cache:
        requests = 0
        def __init__(self, *args): pass
        def encode(self, texts, client):
            assert texts == [saved_topics[0]['description'] if saved_topics else "description", "Approved\nOld source", "New\nFresh source"]
            return np.array([[0., 1.], [1., 0.], [.9, np.sqrt(.19)]])
        def close(self): pass

    client = httpx.Client(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(cloud.httpx, "Client", lambda **kwargs: client)
    monkeypatch.setattr(cloud, "VectorCache", Cache)
    monkeypatch.setattr(cloud, "collect", lambda config, client: [])
    for key in ("READER_API_URL", "READER_SYNC_TOKEN", "SILICONFLOW_API_KEY"):
        monkeypatch.setenv(key, "https://reader.test" if key == "READER_API_URL" else "test")
    path = tmp_path / "config.yaml"
    path.write_text(json.dumps(config))
    digest = cloud.generate(path)
    assert digest["candidate_count"] == 1
    assert digest["items"][0]["reference_url"] == old["url"]
    assert digest["profile"]["mode"] == "personalized"
    assert digest["topics"] == [saved_topics[0]['name'] if saved_topics else 'Initial topic']
    assert [a["url"] for a in published[0]["articles"]] == [fresh["url"]]
