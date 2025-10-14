.PHONY: typecheck test lint format dev

# Type checking
typecheck:
	uv run mypy agent.py

# Linting
lint:
	uv run ruff check .

# Format code
format:
	uv run ruff format .

# Run all checks
check: typecheck lint

# Run the agent in dev mode
dev:
	uv run python agent.py dev

# Install dev dependencies
install-dev:
	uv pip install -e ".[dev]"
