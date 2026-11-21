"""Collect RSS entries into the archive without embedding or publishing a digest."""
import json
import os
from pathlib import Path

import httpx
import yaml

from .generate import archive_articles, collect


def sync(config_path=Path('cloud/config.yaml')):
    config = yaml.safe_load(config_path.read_text(encoding='utf-8'))
    with httpx.Client(timeout=60, headers={'User-Agent': 'SmallWebReader/0.1'}) as client:
        articles = collect(config, client)
        archive_articles(client, os.environ['READER_API_URL'], os.environ['READER_SYNC_TOKEN'], articles)
    print(json.dumps({'archived': len(articles)}))


if __name__ == '__main__':
    sync()
