# 3D maps: game files -> cache/ -> maps/3d/<map>/ (what the radar shows). See docs/maps3d.md.
PY := .venv/bin/python
REPO := ../..
.PHONY: install install-harness cache cache-pull cache-push maps customs streets publish test \
        harness-serve reference-data views reference measure

install:
	python3 -m venv .venv
	.venv/bin/pip install -r requirements.txt

# Stage 1 - needs the game files (EscapeFromTarkov_Data). Incremental.
cache:
	$(PY) extract_cache.py --map customs --map streets

# cache/ lives in Backblaze B2 (assets.json at the repo root; credentials: root README).
cache-pull:
	$(REPO)/scripts/assets.py pull tools/maps3d/cache

cache-push:
	$(REPO)/scripts/assets.py push tools/maps3d/cache --prune

# Stage 2 - cache/ -> maps/3d/<map>/, served by the backend. No game files needed.
maps: customs streets

customs:
	$(PY) build.py --map customs

streets:
	$(PY) build.py --map streets

# Upload the built maps (so machines without this toolchain can pull them); commit assets.json.
publish:
	$(REPO)/scripts/assets.py push maps/3d

test:
	$(PY) -m unittest discover -s . -t .
	cd harness && node --test

# --- measurement harness (harness/README.md) -------------------------------------------------
install-harness:
	cd harness && npm install && npx playwright install --with-deps chromium

# The page capture.mjs drives; uses the web app's vite and its 3D core (cd web && npm install).
harness-serve:
	cd $(REPO)/web && npx vite --config ../tools/maps3d/harness/vite.config.mjs

# Full-detail datasets the overview is compared against (harness/data/, ~0.5 GB, not served).
reference-data:
	$(PY) build.py --map customs --profile reference
	$(PY) build.py --map streets --profile reference --include-indoor --lod 1

# Fixed camera sets, generated from the reference datasets. Committed; regenerate only when a
# map changes (old captures are then not comparable).
views:
	cd harness && $(abspath $(PY)) make_views.py customs views/customs.json
	cd harness && $(abspath $(PY)) make_views.py streets views/streets.json

reference:
	cd harness && node capture.mjs --data customs-reference --views views/customs.json --out runs/customs-reference
	cd harness && node capture.mjs --data streets-reference --views views/streets.json --out runs/streets-reference

# make measure MAP=streets
MAP ?= customs
measure:
	cd harness && node capture.mjs --data $(MAP) --views views/$(MAP).json --out runs/$(MAP)
	cd harness && node compare.mjs runs/$(MAP)-reference runs/$(MAP) --diff runs/$(MAP)/diff
