"""Daily RSS selection for GitHub Actions; secrets never enter static output."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import random
import sqlite3
import time
from datetime import UTC, datetime, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

import feedparser
import httpx
import numpy as np
import yaml


class PlainText(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.parts = []
        self.hidden = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self.hidden += 1

    def handle_endtag(self, tag):
        if tag in ("script", "style"):
            self.hidden = max(0, self.hidden - 1)

    def handle_data(self, data):
        if not self.hidden:
            self.parts.append(data)


def plain(text: str) -> str:
    parser = PlainText()
    parser.feed(text)
    return " ".join(" ".join(parser.parts).split())


def utc_date(value: str) -> datetime:
    try:
        d = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return d.replace(tzinfo=UTC) if d.tzinfo is None else d.astimezone(UTC)
    except (ValueError, TypeError):
        return datetime(1970, 1, 1, tzinfo=UTC)


def collect(config: dict, client: httpx.Client) -> list[dict]:
    articles = {}
    for url in config["feeds"]:
        response = client.get(url, follow_redirects=True)
        response.raise_for_status()
        feed = feedparser.parse(response.content)
        for entry in feed.entries[: config["candidate_limit"]]:
            link = entry.get("link", "")
            if urlparse(link).scheme not in ("http", "https"):
                continue
            summary = entry.get("summary", "")
            if not summary and entry.get("content"):
                summary = entry.content[0].get("value", "")
            content = plain(summary)[:5000]
            if not content:
                continue
            parsed_time = entry.get("published_parsed") or entry.get("updated_parsed")
            published = (
                datetime(*parsed_time[:6], tzinfo=UTC) if parsed_time
                else datetime.now(UTC)
            )
            articles[link] = {
                "url": link, "title": plain(entry.get("title", "Untitled"))[:500],
                "content": content, "summary": content[:1200],
                "source": urlparse(link).hostname or "Personal blog",
                "published_at": published.isoformat(),
                "category": "Small Web", "summary_kind": "excerpt",
            }
    return list(articles.values())


class VectorCache:
    def __init__(self, path: Path, base_url: str, model: str, key: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("CREATE TABLE IF NOT EXISTS vectors (key TEXT PRIMARY KEY, vector TEXT NOT NULL, used_at TEXT NOT NULL)")
        self.base_url, self.model, self.api_key = base_url.rstrip("/"), model, key
        self.requests = 0

    def encode(self, texts: list[str], client: httpx.Client) -> np.ndarray:
        keys = [hashlib.sha256((self.base_url + "\n" + self.model + "\n" + t).encode()).hexdigest() for t in texts]
        result = {}
        missing = {}
        now = datetime.now(UTC).isoformat()
        for key, text in zip(keys, texts):
            row = self.db.execute("SELECT vector FROM vectors WHERE key=?", (key,)).fetchone()
            if row:
                result[key] = json.loads(row[0])
                self.db.execute("UPDATE vectors SET used_at=? WHERE key=?", (now, key))
            else:
                missing[key] = text
        pairs = list(missing.items())
        for offset in range(0, len(pairs), 8):
            batch = pairs[offset:offset + 8]
            response = None
            for attempt in range(4):
                response = client.post(
                    self.base_url + "/embeddings",
                    headers={"Authorization": "Bearer " + self.api_key},
                    json={"model": self.model, "input": [text for _, text in batch]},
                )
                if response.status_code != 429 and response.status_code < 500:
                    break
                if attempt < 3:
                    time.sleep(min(30, 2 ** (attempt + 1)))
            response.raise_for_status()
            data = response.json().get("data", [])
            by_index = {item["index"]: item["embedding"] for item in data}
            if set(by_index) != set(range(len(batch))):
                raise RuntimeError("Embedding response did not match the input batch")
            for i, (key, _) in enumerate(batch):
                vector = by_index[i]
                if not vector or not all(isinstance(x, (float, int)) and math.isfinite(x) for x in vector):
                    raise RuntimeError("Invalid embedding returned by provider")
                result[key] = vector
                self.db.execute("INSERT OR REPLACE INTO vectors VALUES (?,?,?)", (key, json.dumps(vector), now))
            self.requests += 1
        self.db.execute("DELETE FROM vectors WHERE used_at < ?", ((datetime.now(UTC) - timedelta(days=90)).isoformat(),))
        self.db.commit()
        matrix = np.asarray([result[key] for key in keys], dtype=np.float32)
        norms = np.linalg.norm(matrix, axis=1, keepdims=True)
        if np.any(norms <= 0):
            raise RuntimeError("Provider returned a zero vector")
        return matrix / norms

    def close(self):
        self.db.close()


def cluster_interests(vectors: np.ndarray, max_clusters: int = 10) -> tuple[np.ndarray, list[int]]:
    """Deterministic spherical KMeans; returns unit centers and real exemplars.

    Unlike averaging all likes together, separate centers preserve distinct interests.
    This only operates on API embeddings, without loading a language model.
    """
    unique = np.unique(vectors, axis=0)
    k = min(max_clusters, max(1, math.isqrt(len(vectors))), len(unique))
    centers = [unique[0]]
    for _ in range(1, k):
        distance = 1 - (unique @ np.asarray(centers).T).max(axis=1)
        centers.append(unique[int(np.argmax(distance))])
    centers = np.asarray(centers)
    for _ in range(50):
        labels = np.argmax(vectors @ centers.T, axis=1)
        updated = centers.copy()
        for j in range(k):
            members = vectors[labels == j]
            if len(members):
                mean = members.mean(axis=0)
                norm = np.linalg.norm(mean)
                if norm > 0:
                    updated[j] = mean / norm
        if np.allclose(centers, updated, atol=1e-6):
            centers = updated
            break
        centers = updated
    exemplars = [int(np.argmax(vectors @ center)) for center in centers]
    return centers, exemplars


def build_profile(config: dict, articles: list[dict], vectors: np.ndarray, feedback: list[dict]) -> dict:
    states = {row["url"]: row for row in feedback}
    liked, disliked, seen, per_author = [], [], set(), {}
    # One current verdict per URL. Read/save/click are never positive signals.
    for i, article in enumerate(articles):
        url, source = article["url"], article["source"]
        if url in seen or per_author.get(source, 0) >= config.get("profile_per_author", 3):
            continue
        seen.add(url)
        verdict = states.get(url, {}).get("verdict")
        if verdict in ("useful", "topic"):
            (liked if verdict == "useful" else disliked).append(i)
            per_author[source] = per_author.get(source, 0) + 1
    weight = min(1.0, len(liked) / config.get("profile_full_weight_samples", 10))
    centers, exemplars = cluster_interests(vectors[liked], config.get("profile_max_clusters", 10)) if liked else (None, [])
    return {
        "centers": centers,
        "examples": [articles[liked[i]] for i in exemplars],
        "negative_vectors": vectors[disliked],
        "metadata": {
            "algorithm": "explicit-positive-spherical-kmeans-v1",
            "mode": "personalized" if weight == 1 else "learning" if liked else "cold_start",
            "positive_samples": len(liked), "clusters": len(exemplars), "profile_weight": weight,
        },
    }


def select(config: dict, articles: list[dict], vectors: np.ndarray, topics: np.ndarray, feedback: list[dict], run_key: str, *, profile: dict | None = None) -> list[dict]:
    states = {row["url"]: row for row in feedback}
    similarities = vectors @ topics.T
    if profile is None:
        profile = build_profile(config, articles, vectors, feedback)
    weight = profile["metadata"]["profile_weight"]
    centers = profile["centers"]
    interest_similarities = vectors @ centers.T if centers is not None else None
    candidates = []
    now = datetime.now(UTC)
    for i, article in enumerate(articles):
        state = states.get(article["url"], {})
        if state.get("is_read") or state.get("verdict"):
            continue
        topic = int(np.argmax(similarities[i]))
        cluster = int(np.argmax(interest_similarities[i])) if interest_similarities is not None else None
        personal = float(interest_similarities[i, cluster]) if cluster is not None else 0.0
        relevance = (1 - weight) * float(similarities[i, topic]) + weight * personal
        if relevance < config["min_similarity"]:
            continue
        negative = max(0, max((float(vectors[i] @ v) for v in profile["negative_vectors"]), default=0))
        age = max(0, (now - utc_date(article["published_at"])).total_seconds() / 86400)
        score = 0.95 * relevance - 0.05 * negative + 0.05 * math.exp(-age / 14)
        # Diversity follows learned interests once the profile dominates.
        group = ("cluster", cluster) if weight >= .5 else ("topic", topic)
        candidates.append((score, i, group, cluster))
    candidates.sort(key=lambda row: (-row[0], articles[row[1]]["url"]))
    chosen = []; authors = {}; topic_counts = {}; selected_indices = set()
    group_limit = config["max_per_topic"] if weight < .5 else max(config["max_per_topic"], math.ceil(config["daily_limit"] / len(centers)))

    def add(row, exploration=False):
        _, i, topic, cluster = row
        article = articles[i]
        if i in selected_indices or authors.get(article["source"], 0) >= config["max_per_author"] or topic_counts.get(topic, 0) >= group_limit:
            return False
        if any(float(vectors[i] @ vectors[j]) >= config["duplicate_similarity"] for j in selected_indices):
            return False
        category = "兴趣相近" if weight else "兴趣探索"
        if cluster is not None:
            example = profile["examples"][cluster]
            reason = f"接近你标记「有收获」的《{example['title']}》所在兴趣组"
            if weight < 1:
                reason += "；同时参考初始兴趣描述"
        else:
            example = None
            reason = "根据初始兴趣描述探索，尚无你认可的文章样本；主题相关性待确认"
        if exploration:
            reason += "；保留一次探索机会"
        chosen.append({**{k: v for k, v in article.items() if k != "content"}, "category": category, "reason": reason, "exploration": exploration,
                       "recommendation_basis": "profile" if weight == 1 else "mixed" if weight else "topic_description",
                       "reference_url": example["url"] if example else None})
        selected_indices.add(i)
        authors[article["source"]] = authors.get(article["source"], 0) + 1
        topic_counts[topic] = topic_counts.get(topic, 0) + 1
        return True

    limit = config["daily_limit"]
    main_limit = max(0, limit - config.get("exploration_slots", 1))
    # Rank globally; never force a result for each written topic.
    for row in candidates:
        if len(chosen) >= main_limit:
            break
        add(row)
    remainder = [row for row in candidates if row[1] not in selected_indices]
    random.Random(run_key).shuffle(remainder)
    for row in remainder:
        if len(chosen) >= limit:
            break
        add(row, exploration=True)
    return chosen


def generate(config_path: Path, *, publish: bool = True) -> dict:
    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    api_url = os.environ["READER_API_URL"].rstrip("/")
    sync_token = os.environ["READER_SYNC_TOKEN"]
    embedding_key = os.environ["SILICONFLOW_API_KEY"]
    headers = {"Authorization": "Bearer " + sync_token}
    with httpx.Client(timeout=60, headers={"User-Agent": "SmallWebReader/0.1"}) as client:
        response = client.get(api_url + "/internal/snapshot", headers=headers)
        response.raise_for_status()
        snapshot = response.json()
        fresh = collect(config, client)
        pool = {a["url"]: a for a in snapshot["articles"]}
        pool.update({a["url"]: a for a in fresh})
        cutoff = datetime.now(UTC) - timedelta(days=config["max_age_days"])
        articles = sorted((a for a in pool.values() if utc_date(a["published_at"]) >= cutoff), key=lambda a: a["published_at"], reverse=True)[:config["pool_limit"]]
        if not articles:
            raise RuntimeError("No recent articles available; keeping the previous digest")
        # Profile samples survive the candidate age and pool limits. Never publish
        # them back as fresh candidates or cache private verdicts with the vectors.
        profile_pool = {a["url"]: a for a in snapshot.get("profile_articles", snapshot["articles"])}
        profile_pool.update({a["url"]: a for a in articles})
        profile_articles = list(profile_pool.values())
        texts = [t["description"] for t in config["topics"]] + [a["title"] + "\n" + a["content"][:5000] for a in profile_articles]
        cache = VectorCache(Path(os.environ.get("READER_VECTOR_CACHE", "data/cloud/embeddings.sqlite")), config["embedding"]["base_url"], config["embedding"]["model"], embedding_key)
        try:
            vectors = cache.encode(texts, client)
            n = len(config["topics"])
            article_vectors = vectors[n:]
            index = {a["url"]: i for i, a in enumerate(profile_articles)}
            candidate_vectors = article_vectors[[index[a["url"]] for a in articles]]
            profile = build_profile(config, profile_articles, article_vectors, snapshot["feedback"])
            now = datetime.now(ZoneInfo(config["timezone"]))
            digest = {
                "run_key": now.strftime("%Y-%m-%d"), "generated_at": now.isoformat(),
                "embedding_model": config["embedding"]["model"], "candidate_count": len(articles),
                "topics": [t["name"] for t in config["topics"]],
                "profile": profile["metadata"],
                "items": select(config, articles, candidate_vectors, vectors[:n], snapshot["feedback"], now.strftime("%Y-%m-%d"), profile=profile),
            }
            if publish:
                response = client.post(api_url + "/internal/publish", headers=headers, json={"digest": digest, "articles": articles})
                response.raise_for_status()
            print(json.dumps({"date": digest["run_key"], "candidates": len(articles), "selected": len(digest["items"]), "embedding_requests": cache.requests, "published": publish}))
            return digest
        finally:
            cache.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=Path("cloud/config.yaml"))
    args = parser.parse_args()
    generate(args.config)
