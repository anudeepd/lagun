.PHONY: dev build build-frontend licenses dist install install-dev clean lint test test-frontend test-e2e test-all publish

dev:
	python dev.py

# `npm ci`, not `npm install`: the committed bundle must be built from the
# committed lockfile, otherwise two builds of the same commit can ship
# different code. `licenses` runs last so the notices are generated from, and
# cross-checked against, the bundle that was just emitted: Vite copies the
# previous frontend/public/THIRD_PARTY_LICENSES.txt into lagun/static/ during
# the build, and the script then rewrites both copies from the new bundle.
build-frontend:
	cd frontend && npm ci
	cd frontend && npm run build
	$(MAKE) licenses

# Regenerates frontend/public/THIRD_PARTY_LICENSES.txt and the byte-identical
# copy Vite's `publicDir` puts in lagun/static/. Needs frontend/node_modules
# (`cd frontend && npm ci`); commit the result.
licenses:
	python3 scripts/generate-third-party-licenses.py

build: build-frontend
	uv lock --check
	uv build

dist: build

install-dev:
	pip install -e ".[dev]"

install:
	pip install -e .

publish: build
	UV_PUBLISH_TOKEN=$$(python3 -c "import configparser; c = configparser.ConfigParser(); c.read('$${HOME}/.pypirc'); print(c['pypi']['password'])") uv publish

clean:
	rm -rf dist/ build/ *.egg-info lagun/static/* frontend/dist/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete

lint:
	uv run ruff check lagun/
	uv run ruff format --check lagun/

test:
	uv run pytest tests/ -v

test-frontend:
	cd frontend && npm run test

test-e2e:
	cd e2e && npx playwright test

test-all:
	$(MAKE) test
	$(MAKE) test-frontend
	$(MAKE) test-e2e
