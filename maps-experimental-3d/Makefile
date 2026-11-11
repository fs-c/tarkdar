PY := .venv/bin/python
.PHONY: install cache cache-pull cache-push datasets customs inspect explore-customs streets streets-exterior explore-streets dev build

install:
	python3 -m venv .venv
	.venv/bin/pip install -r extract/requirements.txt
	cd viewer && npm install

# Stage 1 - needs the game files (EscapeFromTarkov_Data). Incremental.
cache:
	$(PY) extract/extract_cache.py --map customs --map streets

# cache/ lives in Backblaze B2 (../assets.json); credentials: see the root README.
cache-pull:
	../scripts/assets.py pull cache

cache-push:
	../scripts/assets.py push cache --prune

# Stage 2 - cache/ -> viewer/public/data. No game files needed.
datasets: customs inspect explore-customs streets streets-exterior explore-streets

customs:
	$(PY) extract/build.py --map customs

inspect:
	$(PY) extract/build.py --map customs --profile inspect

explore-customs:
	$(PY) extract/build.py --map customs --profile explore

streets:
	$(PY) extract/build.py --map streets --include-indoor

streets-exterior:
	$(PY) extract/build.py --map streets --name streets-exterior

explore-streets:
	$(PY) extract/build.py --map streets --profile explore --include-indoor --lod 1

dev:
	cd viewer && npm run dev

build:
	cd viewer && npm run build
