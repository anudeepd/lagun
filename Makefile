.PHONY: dev build dist install clean lint test

dev:
	python dev.py

build-frontend:
	cd frontend && npm install && npm run build

build: build-frontend
	python -m build

dist: build

install-dev:
	pip install -e ".[dev]"

install:
	pip install -e .

clean:
	rm -rf dist/ build/ *.egg-info lagun/static/* frontend/dist/
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -name "*.pyc" -delete

lint:
	ruff check lagun/
	ruff format --check lagun/

test:
	pytest tests/ -v
