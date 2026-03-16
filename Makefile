.PHONY: dev build dist install clean lint test test-frontend test-e2e test-all publish

dev:
	python dev.py

build-frontend:
	cd frontend && npm install && npm run build

build: build-frontend
	uv build

dist: build

install-dev:
	pip install -e ".[dev]"

install:
	pip install -e .

publish: build
	uv publish

clean:
	rm -rf dist/ build/ *.egg-info lagun/static/* frontend/dist/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete

lint:
	ruff check lagun/
	ruff format --check lagun/

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
