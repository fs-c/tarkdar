PY := .venv/bin/python
.PHONY: install cache cache-pull cache-push datasets customs inspect explore-customs streets explore-streets legacy dev build test test-extract test-viewer test-harness install-harness views reference measure

install:
	python3 -m venv .venv
	.venv/bin/pip install -r extract/requirements.txt
	cd viewer && npm install

# Headless measurement harness (Playwright + Chromium); see harness/README.md.
install-harness:
	cd harness && npm install && npx playwright install --with-deps chromium

# Stage 1 - needs the game files (EscapeFromTarkov_Data). Incremental.
cache:
	$(PY) extract/extract_cache.py --map customs --map streets

# cache/ lives in Backblaze B2 (../assets.json); credentials: see the root README.
cache-pull:
	../scripts/assets.py pull cache

cache-push:
	../scripts/assets.py push cache --prune

# Stage 2 - cache/ -> viewer/public/data. No game files needed.
datasets: customs inspect explore-customs streets explore-streets

# Overview: merged, simplified cells (exteriors only on Streets).
customs:
	$(PY) extract/build.py --map customs

streets:
	$(PY) extract/build.py --map streets

inspect:
	$(PY) extract/build.py --map customs --profile inspect

explore-customs:
	$(PY) extract/build.py --map customs --profile explore

explore-streets:
	$(PY) extract/build.py --map streets --profile explore --include-indoor --lod 1

# The first overview (per-mesh decimation), for comparison: ?map=customs-legacy
legacy:
	$(PY) extract/build.py --map customs --profile legacy
	$(PY) extract/build.py --map streets --profile legacy

dev:
	cd viewer && npm run dev

build:
	cd viewer && npm run build

# Unit tests. test-extract also runs the HANDOFF validation checks when cache/ is present.
test: test-extract test-viewer test-harness

test-extract:
	$(PY) -m unittest discover -s extract -t extract

test-viewer:
	cd viewer && npm run typecheck && npm test

test-harness:
	cd harness && node --test

# --- measurement harness (needs `make dev` running; see harness/README.md) ---
# The quality bar: explore restricted to these categories.
REF_CATS := structure,terrain,water,glass
DATASET ?= customs
MAP = $(firstword $(subst -, ,$(DATASET)))

# Fixed camera sets, generated from the explore datasets. Committed; regenerate
# only when a map changes (old captures are then not comparable).
views:
	cd harness && $(abspath $(PY)) make_views.py customs-explore views/customs.json
	cd harness && $(abspath $(PY)) make_views.py streets-explore views/streets.json

reference:
	cd harness && node capture.mjs --views views/customs.json --out runs/customs-reference --query "?mode=explore&cats=$(REF_CATS)"
	cd harness && node capture.mjs --views views/streets.json --out runs/streets-reference --query "?mode=explore&map=streets&cats=$(REF_CATS)"

# make measure DATASET=streets-legacy
measure:
	cd harness && node capture.mjs --views views/$(MAP).json --out runs/$(DATASET) --query "?map=$(DATASET)&cats=$(REF_CATS)"
	cd harness && node compare.mjs runs/$(MAP)-reference runs/$(DATASET) --diff runs/$(DATASET)/diff
