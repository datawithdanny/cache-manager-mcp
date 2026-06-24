.PHONY: help install test smoke-mcp smoke-notifier smoke-dashboard smoke-checkpoint smoke-turn smoke-filename smoke-attribution start notifier dashboard \
	zed zed-build zed-check zed-test zed-clean zed-clippy zed-fmt zed-fmt-check clean

ZED_EXTENSION_DIR := .
CARGO := cargo
NPM := npm

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*## "; printf "Available targets:\n"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-20s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install npm dependencies
	$(NPM) install

test: ## Run all npm smoke tests
	$(NPM) test

smoke-mcp: ## Run MCP server smoke test
	$(NPM) run smoke:mcp

smoke-notifier: ## Run notifier smoke test
	$(NPM) run smoke:notifier

smoke-dashboard: ## Run dashboard smoke test
	$(NPM) run smoke:dashboard

smoke-checkpoint: ## Run checkpoint suggestion smoke test
	$(NPM) run smoke:checkpoint

smoke-turn: ## Run turn timer smoke test
	$(NPM) run smoke:turn

smoke-filename: ## Run memory filename smoke test
	$(NPM) run smoke:filename

smoke-attribution: ## Run per-chat cost attribution smoke test
	$(NPM) run smoke:attribution

start: ## Start the MCP server
	$(NPM) start

notifier: ## Start the notifier
	$(NPM) run notifier

dashboard: ## Start the dashboard
	$(NPM) run dashboard

detail: ## Start the dashboard with detailed cost attribution
	$(NPM) run dashboard -- --detail

zed: zed-clean zed-fmt-check zed-clippy zed-test zed-build ## Clean, validate, test, and compile the Zed Rust extension

zed-build: ## Compile the Zed Rust extension
	$(CARGO) build --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml

zed-check: ## Check the Zed Rust extension
	$(CARGO) check --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml

zed-test: ## Run Zed Rust extension tests
	$(CARGO) test --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml

zed-clippy: ## Run clippy for the Zed Rust extension
	$(CARGO) clippy --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml -- -D warnings

zed-fmt: ## Format the Zed Rust extension
	$(CARGO) fmt --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml

zed-fmt-check: ## Check Zed Rust extension formatting
	$(CARGO) fmt --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml -- --check

zed-clean: ## Remove Zed Rust extension build artifacts
	$(CARGO) clean --manifest-path $(ZED_EXTENSION_DIR)/Cargo.toml

clean: zed-clean ## Remove generated build artifacts
